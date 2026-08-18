import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { authMiddleware, apiKeyAuthMiddleware } from '../middleware/auth.middleware.js';
import { forcePasswordResetMiddleware } from '../middleware/password-reset.middleware.js';
import { inferenceRateLimit } from '../middleware/security.middleware.js';
import { uploadMiddleware, multerErrorHandler } from '../middleware/upload.middleware.js';
import { mask } from '../services/pii-masker.service.js';
import { validateModelId, generate, invokeNovaForOCR, repairResponse, semanticJudge, InferenceError } from '../services/inference.service.js';
import { validateAndClassifyFiles } from '../services/upload-validator.service.js';
import { supportsImages, getVisionModels } from '../config/model-capabilities.js';
import { extractDocumentText } from '../services/document-extractor.service.js';
import { processImages } from '../services/image-processor.service.js';
import { buildContentBlocks } from '../services/content-builder.service.js';
import { auditService } from '../services/audit.service.js';
import { configService } from '../services/config.service.js';
import { routeRequest, verifyOutput, getDefaultFormatTemplate } from '../services/routing-engine.service.js';
import {
  getActiveSession,
  getSessionMessages,
  getValidatedSession,
  storeMessage,
  markSessionInactive,
  transitionToDegraded,
  incrementTurnCount,
  SessionExpiredError,
  SessionNotFoundError,
} from '../services/session.service.js';
import { buildContext, buildKnowledgeSection } from '../services/context-assembly.service.js';
import type { ContextConfig } from '../services/context-assembly.service.js';
import { search as knowledgeSearch } from '../services/knowledge.service.js';
import { tryAcquireSessionLock } from '../config/database.js';
import { loadMemoryState, summarizeEvicted, extractFacts } from '../services/session-memory.service.js';
import { getFewShotExamples } from '../services/few-shot-library.js';
import { config } from '../config/index.js';
import { getRoleForSkill } from '../config/skill-role-map.js';
import type { RoutingMetadataEvent } from '../types/inference.types.js';
import { DEFAULT_MODEL } from '../types/inference.types.js';
import type { RoutingInput, RoutingDecision } from '../types/routing.types.js';
import { sequentialReasoner } from '../services/sequential-reasoning.service.js';
import type { ContentBlock, DocumentContentBlock } from '../types/upload.types.js';
import type { ConversationInferenceRequest, ConversationInferenceResult, BedrockMessage } from '../types/session.types.js';

/**
 * Inference routes — POST /api/v1/inference/generate
 * Handles prompt validation, PII masking, SSE streaming, and audit logging.
 * Supports both JSON (text-only) and multipart/form-data (with file attachments).
 *
 * @see Requirements 2.1, 2.2, 2.3, 2.4, 4.2, 5.3, 5.4, 6.1, 6.3, 8.1
 */

/**
 * Distributed turn lock via PostgreSQL advisory lock.
 * Prevents concurrent turns on the same session across all Cloud Run instances
 * sharing the same PostgreSQL. Lock is automatically released on connection close
 * (crash-safe), but always call releaseSessionLock() in a finally block.
 *
 * @see database.ts → tryAcquireSessionLock / releaseSessionLock
 */

/** Backward-compatible stub for tests that expect activeTurns.clear(). */
export const activeTurns = { clear() {} };

/**
 * Nova Lite uses the raw InvokeModel API (Messages schema), not Converse.
 * It works directly in ap-southeast-3 — no inference profile needed.
 */
const NOVA_LITE_MODEL = 'amazon.nova-lite-v1:0';
function resolveModelForInvocation(modelId: string): string {
  return modelId;
}

export const inferenceRouter = Router();

/**
 * GET /sessions/active
 *
 * Returns the active session and sanitized conversation history for the authenticated user.
 * When no active session exists, returns HTTP 200 with { session: null, messages: [] }.
 *
 * @see Requirements 8.1, 8.2, 8.3, 8.4
 */
inferenceRouter.get('/sessions/active', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;

  try {
    const session = await getActiveSession(user.sub);

    if (!session) {
      res.status(200).json({ session: null, messages: [] });
      return;
    }

    const storedMessages = await getSessionMessages(session.id);
    const messages = storedMessages.map((msg) => ({
      role: msg.role,
      content: msg.sanitizedContent,
      createdAt: msg.createdAt,
    }));

    res.status(200).json({ session, messages });
  } catch (error: unknown) {
    console.error('[sessions/active] Failed to retrieve active session:', error);
    res.status(500).json({
      error: 'SESSION_RETRIEVAL_ERROR',
      message: 'Failed to retrieve active session',
    });
  }
});

/**
 * POST /generate
 *
 * Detects content-type:
 * - multipart/form-data → handleMultipartInference (new, with file uploads)
 * - application/json (or other) → handleJsonInference (existing text-only)
 *
 * Rate limited: 20 requests per minute per IP.
 */
inferenceRouter.post('/generate', authMiddleware, forcePasswordResetMiddleware, inferenceRateLimit, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    return handleMultipartInference(req, res, next);
  }

  return handleJsonInference(req, res);
});

/**
 * POST /batch
 *
 * Non-streaming batch inference for machine-to-machine calls.
 * Auth: x-api-key header (apiKeyAuthMiddleware).
 *
 * Request headers:
 *   - x-api-key: string (required — API key from admin panel)
 *   - x-username: string (required ONLY if application billing_mode is PER_USER)
 *
 * Request body:
 *   - prompt: string (required, non-empty, ≤256KB)
 *   - modelId: string (required — manual routing always)
 *   - config: { maxTokens?, temperature? } (optional)
 *   - responseFormat: "json" (optional, enables response_format: json_object)
 *
 * Response: Plain JSON { summary, decisions, actionItems, metadata }
 *
 * Flow:
 *   1. API key auth → 2. Validate prompt → 3. PII mask (fail-closed)
 *   → 4. Call Bedrock non-streaming → 5. Post-inference PII scan
 *   → 6. Audit log with billing context → 7. Return structured JSON
 */
inferenceRouter.post('/batch',
  // Use route-level JSON parser with larger limit for transcripts
  express.json({ limit: config.batch.bodyLimit }),
  apiKeyAuthMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const startTime = Date.now();
    const { prompt, modelId, config: inferenceConfig, responseFormat } = req.body;
    const user = req.user!;

    // 1. Validate prompt
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      res.status(400).json({ error: 'EMPTY_PROMPT', message: 'Prompt cannot be empty' });
      return;
    }

    if (prompt.length > config.batch.maxPromptLength) {
      res.status(400).json({
        error: 'PROMPT_TOO_LONG',
        message: `Prompt exceeds maximum length of ${config.batch.maxPromptLength.toLocaleString()} characters`,
      });
      return;
    }

    // 2. Validate modelId
    let validatedModelId: string;
    try {
      validatedModelId = await validateModelId(modelId, user.sub);
    } catch (error: unknown) {
      const err = error as Error & { code?: string; statusCode?: number };
      res.status(err.statusCode ?? 400).json({
        error: err.code ?? 'INVALID_MODEL',
        message: err.message,
      });
      return;
    }

    // 3. PII mask (fail-closed)
    let maskedPrompt: string;
    try {
      maskedPrompt = mask(prompt).maskedText;
    } catch {
      res.status(500).json({
        error: 'MASKING_ERROR',
        message: 'Failed to process prompt. Please try again.',
      });
      return;
    }

    // 4. Build Bedrock Converse messages (single-turn, no session)
    const forceJson = responseFormat === 'json';
    const messages = [{ role: 'user' as const, content: [{ text: maskedPrompt }] }];

    // Build system prompt — force JSON with exact schema
    const systemPrompt = forceJson
      ? [
          'You are an executive meeting analyst for Indonesian banking.',
          'Analyze the meeting transcript and output ONLY valid JSON — no markdown, no commentary.',
          '',
          'OUTPUT THIS EXACT JSON STRUCTURE:',
          '{',
          '  "summary": "Executive summary in 3-5 paragraphs. Cover key topics, discussion points, outcomes, and context. Use the same language as the transcript (Indonesian or English)."',
          '  "decisions": ["Decision 1", "Decision 2", ...]',
          '  "actionItems": [',
          '    { "task": "Specific task description", "owner": "Person name or [NAMA_X] placeholder" }',
          '  ]',
          '}',
          '',
          'CRITICAL RULES:',
          '- Output ONLY the raw JSON object. No ```json fences. No markdown headers. No "Here is the output" text.',
          '- NEVER expand or change PII placeholders. [NIK_1], [NO_HP_1], [NAMA_1] etc. must stay exactly as-is.',
          '- If no decisions were made, return empty array: "decisions": [].',
          '- If no action items, return empty array: "actionItems": [].',
          '- Owner field is optional — omit if no owner was mentioned.',
          '- Be concise. Summary ~3-5 paragraphs.',
        ].join('\n')
      : [
          'You are an AI meeting assistant for Indonesian banking.',
          'Analyze the transcript and produce a structured summary with decisions and action items.',
          'Keep PII placeholders intact. Be concise.',
        ].join('\n');

    // 5. Call Bedrock non-streaming
    const maxTokens = inferenceConfig?.maxTokens ?? 8192;

    let resultText = '';
    try {
      const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
      const bedrockClient = new BedrockRuntimeClient({ region: config.aws.region });

      const converseParams: Record<string, unknown> = {
        modelId: validatedModelId,
        system: [{ text: systemPrompt }],
        messages,
        inferenceConfig: {
          maxTokens,
          temperature: forceJson ? 0.1 : (inferenceConfig?.temperature ?? 0.3),
        },
      };

      // Force structured JSON output via Bedrock API
      if (forceJson) {
        converseParams.responseFormat = { type: 'json_object' };
      }

      // Retry once without json_object if model rejects it
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const command = new ConverseCommand(converseParams as any);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 120_000);
          try {
            const response = await bedrockClient.send(command, { abortSignal: controller.signal });
            resultText = response.output?.message?.content?.[0]?.text ?? '';
            lastError = null;
            break;
          } finally {
            clearTimeout(timeout);
          }
        } catch (err: unknown) {
          lastError = err;
          const msg = (err as Error).message || '';
          // If model rejects json_object, retry without it
          if (forceJson && attempt === 0 && (msg.includes('json_object') || msg.includes('responseFormat') || msg.includes('ValidationException'))) {
            console.warn('[batch] model rejected json_object, retrying without response_format');
            delete converseParams.responseFormat;
            continue;
          }
          throw err;
        }
      }
      if (lastError) throw lastError;
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      console.error('[batch] Bedrock inference failed:', (error as Error).message);
      auditService.log({
        timestamp: new Date().toISOString(),
        userId: user.sub, username: user.username, modelId: validatedModelId,
        inputTokens: Math.ceil(maskedPrompt.length / 4), outputTokens: 0,
        status: 'failed', errorCategory: (error as Error).name === 'TimeoutError' ? 'timeout' : 'model_error',
        durationMs, routingState: 'manual', routingReasonCode: 'batch-inference',
        reasoningSummary: 'Batch inference', executedModelId: validatedModelId,
        manualOverrideApplied: true,
        apiKeyId: req.apiKeyContext?.apiKeyId,
        applicationId: req.apiKeyContext?.applicationId, apiKeyUsed: true,
      }).catch(() => {});
      res.status(500).json({ error: 'INFERENCE_ERROR', message: 'Model inference failed' });
      return;
    }

    // 6. Post-inference PII scan (defense-in-depth)
    let piiIssues = 0;
    if (resultText) {
      const outputMaskResult = mask(resultText);
      piiIssues = outputMaskResult.entityCount;
      if (piiIssues > 0) {
        console.error(`[batch] PII_OUTPUT_SCAN_FAILED: ${piiIssues} entities`);
        const durationMs = Date.now() - startTime;
        auditService.log({
          timestamp: new Date().toISOString(),
          userId: user.sub, username: user.username, modelId: validatedModelId,
          inputTokens: Math.ceil(maskedPrompt.length / 4), outputTokens: Math.ceil(resultText.length / 4),
          status: 'failed', errorCategory: 'pii_output_scan', durationMs,
          routingState: 'manual', routingReasonCode: 'batch-inference',
          reasoningSummary: 'PII detected in model output — discarded', executedModelId: validatedModelId,
          manualOverrideApplied: true,
          apiKeyId: req.apiKeyContext?.apiKeyId,
          applicationId: req.apiKeyContext?.applicationId, apiKeyUsed: true,
        }).catch(() => {});
        res.status(500).json({ error: 'PII_OUTPUT_SCAN_FAILED', message: 'PII detected in model output.' });
        return;
      }
    }

    // 7. Parse structured output — JSON first, then markdown fallback
    let summary = resultText;
    let decisions: string[] = [];
    let actionItems: Array<{ task: string; owner?: string }> = [];

    // Try JSON parse
    const jsonParsed = tryParseJSON(resultText);
    if (jsonParsed) {
      summary = String(jsonParsed.summary ?? jsonParsed.Summary ?? resultText);
      decisions = asStringArray(jsonParsed.decisions ?? jsonParsed.Decisions);
      actionItems = asActionItems(jsonParsed.actionItems ?? jsonParsed.action_items ?? jsonParsed.ActionItems);
    } else if (forceJson) {
      // JSON parse failed but we requested JSON — try markdown extraction
      console.warn('[batch] JSON parse failed, attempting markdown extraction');
      const extracted = extractFromMarkdown(resultText);
      if (extracted) {
        summary = extracted.summary;
        decisions = extracted.decisions;
        actionItems = extracted.actionItems;
      }
    }

    // 8. Audit log (success, fire-and-forget)
    const durationMs = Date.now() - startTime;
    auditService.log({
      timestamp: new Date().toISOString(),
      userId: user.sub,
      username: user.username,
      modelId: validatedModelId,
      inputTokens: Math.ceil(maskedPrompt.length / 4),
      outputTokens: Math.ceil(resultText.length / 4),
      status: 'success',
      durationMs,
      routingState: 'manual',
      routingReasonCode: 'batch-inference',
      reasoningSummary: 'Batch inference',
      executedModelId: validatedModelId,
      manualOverrideApplied: true,
      apiKeyId: req.apiKeyContext?.apiKeyId,
      applicationId: req.apiKeyContext?.applicationId,
      apiKeyUsed: true,
    }).catch(() => {});

    // 9. Return structured response
    res.status(200).json({
      summary,
      decisions,
      actionItems,
      metadata: {
        modelId: validatedModelId,
        inputTokens: Math.ceil(maskedPrompt.length / 4),
        outputTokens: Math.ceil(resultText.length / 4),
        durationMs,
        piiMasked: true,
        hasPostInferencePiiScan: true,
        postInferencePiiIssues: 0,
      },
    });
  },
);

// Apply multer error handler for multipart request errors
inferenceRouter.use(multerErrorHandler);

/**
 * Handle JSON text-only inference requests (existing behavior).
 *
 * Request body:
 *   - prompt: string (required, non-empty)
 *   - modelId: string (optional, defaults to qwen.qwen3-32b-v1:0)
 *   - config: { maxTokens?, temperature?, topP? } (optional)
 *   - sessionId: string (optional, resumes existing session)
 *
 * Response: SSE stream with events: routing (optional), delta, metadata, done, error
 *
 * Turn lifecycle:
 *   1. Validate session → 2. Acquire turn lock → 3. Save user message (fail-fast)
 *   → 4. Build context → 5. Stream AI response → 6. Save assistant message
 *   → 7. Increment turn count (or degrade on failure) → 8. Release lock
 *
 * @see Requirements 2.1, 2.2, 2.3, 2.4, 1.3, 1.4, 1.6, 3.1, 4.1
 */
async function handleJsonInference(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  const { prompt, modelId, config: inferenceConfig } = req.body;
  const user = req.user!;

  // 1. Validate prompt is non-empty
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    res.status(400).json({
      error: 'EMPTY_PROMPT',
      message: 'Prompt cannot be empty',
    });
    return;
  }

  // 1b. Limit prompt length (prevent abuse — max 32KB)
  if (prompt.length > 64_000) {
    res.status(400).json({
      error: 'PROMPT_TOO_LONG',
      message: 'Prompt exceeds maximum length of 64,000 characters',
    });
    return;
  }

  // 2. Validate modelId against allowed list (async — checks private model access)
  let validatedModelId: string;
  try {
    validatedModelId = await validateModelId(modelId, user.sub);
  } catch (error: unknown) {
    const err = error as Error & { code?: string; statusCode?: number };
    res.status(err.statusCode ?? 400).json({
      error: err.code ?? 'INVALID_MODEL',
      message: err.message,
    });
    return;
  }

  // 3. Mask the prompt with PII masker (fail-closed: reject if masking errors)
  let maskedPrompt: string;
  try {
    const maskResult = mask(prompt);
    maskedPrompt = maskResult.maskedText;
  } catch {
    res.status(500).json({
      error: 'MASKING_ERROR',
      message: 'Failed to process prompt. Please try again.',
    });
    return;
  }

  // 4. Prompt-too-large pre-check against session context character budget
  if (maskedPrompt.length > config.session.maxContextCharacters) {
    res.status(413).json({
      error: 'PROMPT_TOO_LARGE',
      message: 'Prompt exceeds maximum allowed length.',
    });
    return;
  }

  // 5. Validate session — catch SessionExpiredError / SessionNotFoundError
  let sessionId: string;
  try {
    const session = await getValidatedSession(user.sub, req.body.sessionId);
    sessionId = session.id;
  } catch (sessionError: unknown) {
    if (sessionError instanceof SessionExpiredError) {
      // Set SSE headers and emit error event
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'SESSION_EXPIRED', message: 'Session expired' })}\n\n`);
      res.end();
      return;
    }
    if (sessionError instanceof SessionNotFoundError) {
      res.status(404).json({
        error: 'SESSION_NOT_FOUND',
        message: 'Session not found',
      });
      return;
    }
    // Unexpected session error
    console.error('[inference] Session validation failed:', (sessionError as Error).message);
    res.status(500).json({
      error: 'SESSION_ERROR',
      message: 'Failed to validate session',
    });
    return;
  }

  // 6. Turn lock — prevent concurrent turns on the same session (distributed via PostgreSQL)
  const { locked: acquired, release } = await tryAcquireSessionLock(sessionId);
  if (!acquired) {
    res.status(409).json({
      error: 'TURN_IN_PROGRESS',
      message: 'Please wait for the current response to finish.',
    });
    return;
  }

  try {
    // 7. Store user message — FAIL-FAST: if it throws, do NOT call AI
    try {
      await storeMessage(sessionId, 'user', maskedPrompt, { piiMasked: true });
    } catch (storeError: unknown) {
      console.error('[inference] Failed to store user message:', (storeError as Error).message);
      res.status(500).json({
        error: 'PERSISTENCE_ERROR',
        message: 'Failed to save message. Please try again.',
      });
      return;
    }

    // 8. Fetch session messages and build context using unified buildContext()
    const allMessages = await getSessionMessages(sessionId);
    // Exclude the just-stored current user message from history
    const historyMessages = allMessages.slice(0, -1);

    // Load session memory for rolling summary injection
    const memoryState = await loadMemoryState(sessionId);

    const contextConfig: ContextConfig = {
      maxHistoryMessages: config.session.maxHistoryTurns * 2,
      maxContextCharacters: config.session.maxContextCharacters,
      memoryState,
    };

    const contextOutput = buildContext(historyMessages, maskedPrompt, contextConfig);

    // 9. Determine routing state and execute routing logic
    // Check global passthrough mode (cached in-memory, fast path)
    const globalPassthrough = await configService.getPassthroughMode();
    const routingState: 'auto' | 'manual' | 'passthrough' =
      globalPassthrough ? 'passthrough' :
      (!modelId || modelId.trim().length === 0) ? 'auto' : 'manual';

    let executedModelId: string = validatedModelId;
    let effectivePrompt: string = maskedPrompt;
    const isPassthrough = routingState === 'passthrough';

    // Construct routing decision once, used in both auto and manual paths below
    let routingDecision: RoutingDecision | undefined;

    if (routingState === 'passthrough') {
      // Passthrough: no routing, no refinement, minimal decision
      executedModelId = validatedModelId || 'qwen.qwen3-32b-v1:0';
      effectivePrompt = maskedPrompt;
      routingDecision = {
        executedModelId,
        routingState: 'passthrough',
        complexityScore: 0,
        scoreBand: 'direct-answer',
        confidence: 1.0,
        refinedPrompt: maskedPrompt,
        routingReasonCode: 'passthrough',
        reasoningSummary: 'Passthrough mode — raw prompt, no routing',
        modalityFlags: { textOnly: true, documentText: false, image: false, mixed: false },
        manualOverrideApplied: false,
        passthrough: true,
        flags: ['passthrough'],
        skill: 'fallback',
        contract: null,
        sessionContext: maskedPrompt.slice(0, 120), // first 120 chars as preview
      };
    } else if (routingState === 'auto') {
      // Use routing_payload from contextOutput as conversation context
      const conversationContext = contextOutput.routing_payload;

      // Build routing input for auto routing
      const routingInput: RoutingInput = {
        originalPrompt: maskedPrompt,
        hasImages: false,
        imageModelRequired: false,
        routingState: 'auto',
        userId: user.sub,
        conversationContext,
      };

      try {
        console.log(`[inference] Starting auto routing for prompt (${maskedPrompt.length} chars)...`);
        const routingStart = Date.now();
        routingDecision = await routeRequest(routingInput);
        const routingDuration = Date.now() - routingStart;
        executedModelId = routingDecision.executedModelId;
        effectivePrompt = routingDecision.refinedPrompt;
        // Attach raw LLM call data for debugging
        (routingDecision as any)._classRaw = (routingDecision as any)._classRaw || (routingDecision as any).contract?._classRaw;
        (routingDecision as any)._classPrompt = (routingDecision as any)._classPrompt || (routingDecision as any).contract?._classPrompt;
        (routingDecision as any)._refineRaw = (routingDecision as any)._refineRaw || (routingDecision as any).contract?._refineRaw;
        (routingDecision as any)._refinePrompt = (routingDecision as any)._refinePrompt || (routingDecision as any).contract?._refinePrompt;
        console.log(`[inference] Routing complete in ${routingDuration}ms → model=${executedModelId}, score=${routingDecision.complexityScore}, band=${routingDecision.scoreBand}, flags=[${routingDecision.flags.join(',')}]`);
      } catch (routingError: unknown) {
        // Routing engine failure: fallback to DEFAULT_MODEL, log warning
        executedModelId = DEFAULT_MODEL;
        console.warn('[routing-fallback] Routing engine failed, falling back to default model:', (routingError as Error).message);
        routingDecision = {
          executedModelId: DEFAULT_MODEL,
          routingState: 'auto',
          complexityScore: 2,
          scoreBand: 'direct-answer',
          confidence: 0,
          refinedPrompt: maskedPrompt,
          routingReasonCode: 'routing-fallback',
          reasoningSummary: 'Routing engine failed, using default model',
          modalityFlags: { textOnly: true, documentText: false, image: false, mixed: false },
          manualOverrideApplied: false,
          flags: ['routing-fallback'],
          skill: 'fallback',
          contract: null,
        };
      }
    } else {
      // Manual state: use user-selected model
      routingDecision = {
        executedModelId: validatedModelId,
        routingState: 'manual',
        complexityScore: 0,
        scoreBand: 'direct-answer',
        confidence: 1.0,
        refinedPrompt: maskedPrompt,
        routingReasonCode: 'manual-override',
        reasoningSummary: `Manual routing: user selected model ${validatedModelId}`,
        modalityFlags: { textOnly: true, documentText: false, image: false, mixed: false },
        manualOverrideApplied: true,
        flags: [],
        skill: 'fallback',
        contract: null,
      };
    }

    // 10. Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // 10b. Emit session SSE event with sessionId for frontend
    res.write(`event: session\ndata: ${JSON.stringify({ sessionId })}\n\n`);

    // 10c. Emit routing metadata SSE event if enabled
    if (config.routing.metadataEnabled && routingDecision) {
      const routingMetadata: RoutingMetadataEvent = {
        refinedPrompt: routingDecision.refinedPrompt,
        complexityScore: routingDecision.complexityScore,
        scoreBand: routingDecision.scoreBand,
        routingState: routingDecision.routingState,
        executedModelId: routingDecision.executedModelId,
        routingReasonCode: routingDecision.routingReasonCode,
        reasoningSummary: routingDecision.reasoningSummary,
        modalityFlags: routingDecision.modalityFlags,
        manualOverrideApplied: routingDecision.manualOverrideApplied,
        skill: routingDecision.skill,
        contract: routingDecision.contract as Record<string, unknown> | null | undefined,

        // Confidence & flags
        confidence: routingDecision.confidence,
        flags: routingDecision.flags,

        // Timing (ms per routing step)
        routingDurationMs: routingDecision.routingDurationMs,
        classificationDurationMs: routingDecision.classificationDurationMs,
        refinementDurationMs: routingDecision.refinementDurationMs,
        scoringDurationMs: routingDecision.scoringDurationMs,

        // Prompt info
        originalPromptLength: maskedPrompt.length,
        promptLengthAfterRefinement: effectivePrompt.length,

        // Conversation context
        conversationContext: contextOutput.routing_payload,
        historyMessageCount: contextOutput.historyMessageCount,
        contextTruncated: contextOutput.truncated,

        // Session memory
        memorySummary: memoryState.summary ?? undefined,
        memoryVersion: memoryState.memoryVersion,
        memoryFacts: memoryState.facts,
        // Raw LLM call data for debugging (routeRequest internals)
        _classificationRaw: (routingDecision as any)?._classRaw,
        _classificationPrompt: (routingDecision as any)?._classPrompt,
        _refinementRaw: (routingDecision as any)?._refineRaw,
        _refinementPrompt: (routingDecision as any)?._refinePrompt,
      };
      res.write(`event: routing\ndata: ${JSON.stringify(routingMetadata)}\n\n`);
    }

    // 11. Inject ambiguities into prompt if contract flagged them
    if (routingDecision?.contract?.clarificationNeeded && routingDecision?.contract?.ambiguities?.length > 0) {
      const ambigNote = '\n\nNote: The following aspects of my request may be unclear. Please address them if possible:\n- ' + routingDecision.contract.ambiguities.join('\n- ');
      effectivePrompt += ambigNote;
    }

    // 11b. Build inference request using contextOutput.inference_payload
    const inferenceMessages: BedrockMessage[] = contextOutput.inference_payload.slice(0, -1);
    const currentUserMessage: BedrockMessage = {
      role: 'user',
      content: [{ text: effectivePrompt }],
    };
    // Inject skill-specific few-shot examples for format adherence (skip in passthrough)
    let conversationMessages: BedrockMessage[];
    if (isPassthrough) {
      conversationMessages = [...inferenceMessages, currentUserMessage];
    } else {
      const fewShotPairs = getFewShotExamples(routingDecision?.skill || 'fallback');
      conversationMessages = [...inferenceMessages, ...fewShotPairs, currentUserMessage];
    }

    // Knowledge retrieval (Tier 2) — hybrid search with self-timeout; degrades to [] on failure.
    const knowledgeChunks = await knowledgeSearch(effectivePrompt, config.knowledge.topK);

    // Cohere Embed v4 usage: the retrieval query is embedded once per turn (input tokens ≈ chars/4).
    const embeddingInputTokens = Math.ceil(effectivePrompt.length / 4);
    res.write(`event: embedding\ndata: ${JSON.stringify({
      inputTokens: embeddingInputTokens,
      chunks: knowledgeChunks.map((c) => ({
        id: c.id,
        title: c.title,
        docType: c.docType,
        score: c.score,
        bindingLevel: c.bindingLevel,
        sourceType: c.sourceType,
      })),
    })}\n\n`);

    const passthroughRole = 'a helpful assistant';
    const conversationRequest: ConversationInferenceRequest = {
      messages: conversationMessages,
      modelId: resolveModelForInvocation(executedModelId),
      userId: user.sub,
      system: (() => {
        const role = routingDecision?.contract?.role || getRoleForSkill(routingDecision?.skill || 'fallback');
        const lang = routingDecision?.detectedLanguage || 'indonesian';
        const bi = routingDecision?.contract?.behavioral_instructions;
        const skill = routingDecision?.skill || 'fallback';
        // Use deterministic template if available (preferred), fall back to legacy dynamic output_format
        const formatTemplate = getDefaultFormatTemplate(skill) || routingDecision?.contract?.output_format;

        // Start with a clear instruction or role identity, then language
        let s: string;
        if (isPassthrough) {
          s = 'You are ' + passthroughRole + '. Respond in ' + lang + '.';
        } else {
          s = 'You are ' + role + '. Respond in ' + lang + '.';
        }

        // Markdown formatting instruction — explicit, works for both EN and ID
        const FORMAT_INSTRUCTION = [
          'IMPORTANT FORMAT RULES:',
          '- Use ## and ### for section headings (not just bold or emoji)',
          '- Use - for bullet lists',
          '- Use 1. for numbered lists',
          '- Use ``` for code blocks with language label',
          '- Use **bold** for emphasis, *italic* for secondary',
          '- Use > for quotes',
          '- Use |---| for tables',
        ].join('\n');

        if (isPassthrough || !formatTemplate) {
          s += '\n\n' + FORMAT_INSTRUCTION;
        } else {
          s += '\n\nFollow this output structure:\n' + formatTemplate;
        }

        // Append behavioral instructions if present
        if (bi) s += '\n\n' + bi;

        // Knowledge Layer: inject retrieved reference documents + citation rule.
        const knowledgeSection = buildKnowledgeSection(knowledgeChunks);
        if (knowledgeSection) s += '\n\n' + knowledgeSection;

        // Grounding: prevent hallucination by anchoring to provided context
        s += '\n\nIf the user provides documents or data, base your answer strictly on that material. If asked about something not covered in the provided information, say "Informasi ini tidak tersedia dalam dokumen yang diberikan" instead of guessing. For facts, numbers, and regulations, do not fabricate — state your uncertainty if unsure.';

        return s;
      })(),
      ...(inferenceConfig && {
        inferenceConfig: {
          maxTokens: inferenceConfig.maxTokens,
          temperature: inferenceConfig.temperature,
          topP: inferenceConfig.topP,
        },
      }),
    };

    let orchestrationMeta: any;

    try {
      console.log(`[inference] Calling generate() with model=${resolveModelForInvocation(executedModelId)}, prompt length=${effectivePrompt.length}, history messages=${contextOutput.historyMessageCount}`);

      // ── Execution Branch ─────────────────────────────────────────
      let result: ConversationInferenceResult;

      // Unified dispatch: sequential reasoning for complex queries (≥4), single-shot otherwise
      // Skip sequential reasoning in passthrough mode
      if ((routingDecision?.complexityScore ?? 0) >= 4 && routingDecision?.routingState !== 'manual' && !isPassthrough) {
        const seqInput = {
          originalPrompt: maskedPrompt,
          refinedPrompt: effectivePrompt,
          maskedDocumentText: undefined,
          conversationHistory: inferenceMessages,
          userId: user.sub,
          sessionId,
          username: user.username,
          routingDecision,
        };
        console.log(`[inference] Sequential reasoning triggered: complexity=${routingDecision.complexityScore}, calling SequentialReasoner`);
        const seqResult = await sequentialReasoner.execute(seqInput, res);

        if (seqResult) {
          console.log(`[inference] Sequential reasoning complete: ${seqResult.assistantText.length} chars, ${seqResult.stepResults.filter(r => r.status === 'success').length}/${seqResult.stepResults.length} steps`);
          orchestrationMeta = seqResult.orchestrationMeta as any;
          result = {
            assistantText: seqResult.assistantText,
            inputTokens: seqResult.orchestrationMeta.totalInputTokens,
            outputTokens: seqResult.orchestrationMeta.totalOutputTokens,
            modelId: executedModelId,
            status: 'success',
          };
        } else {
          console.log('[inference] Sequential reasoning plan failed, falling back to single-shot generate()');
          result = await generate(conversationRequest, res) as ConversationInferenceResult;
        }
      } else {
        result = await generate(conversationRequest, res) as ConversationInferenceResult;
      }

      // Done is emitted below after verifier + semantic repair.
      // generate() already emitted done internally. This ensures repair results
      // arrive BEFORE done on the frontend so they can be processed.

      // 12. Run verifier if we have a contract (skip in passthrough)
      if (!isPassthrough && routingDecision?.contract && result.assistantText) {
        try {
          const verification = verifyOutput(routingDecision.contract, result.assistantText);
          res.write(`event: verification\ndata: ${JSON.stringify(verification)}\n\n`);
          console.log(`[verification] ${verification.passed ? 'PASSED' : 'FAILED'} — ${verification.violations.length} violations`);

          // Auto-repair: if verification failed, fix violated parts (fire-and-forget style)
          if (!verification.passed && verification.violations.filter(v => v.severity === 'error').length > 0) {
            const repairMessages = conversationMessages.map(msg => ({
              role: msg.role as 'user' | 'assistant',
              content: msg.content,
            }));
            repairResponse(
              executedModelId,
              repairMessages,
              verification.violations,
            ).then(repairText => {
              if (repairText) {
                const sanitizedRepair = mask(repairText).maskedText;
                res.write(`event: repair\ndata: ${JSON.stringify({ text: sanitizedRepair })}\n\n`);
                console.log(`[repair] Auto-repair generated: ${sanitizedRepair.length} chars`);
              }
            }).catch(() => { /* fire-and-forget */ });
          }

          // Semantic verification (LLM-as-a-judge) for high-stakes skills
          const semanticVerdict = await semanticJudge(
            maskedPrompt,
            result.assistantText,
            routingDecision?.skill || 'fallback',
          );
          if (semanticVerdict && !semanticVerdict.is_correct && semanticVerdict.missing_elements.length > 0) {
            res.write(`event: semantic_verdict\ndata: ${JSON.stringify(semanticVerdict)}\n\n`);
            console.log(`[semantic-judge] FAILED — ${semanticVerdict.missing_elements.length} missing elements`);

            // Feed into repair pipeline
            const semRepairMessages = conversationMessages.map(msg => ({
              role: msg.role as 'user' | 'assistant',
              content: msg.content,
            }));
            repairResponse(
              executedModelId,
              semRepairMessages,
              semanticVerdict.missing_elements.map(m => ({
                field: 'semantic', issue: m, severity: 'error' as const,
              })),
            ).then(repairText => {
              if (repairText) {
                const sanitizedRepair = mask(repairText).maskedText;
                res.write(`event: repair\ndata: ${JSON.stringify({ text: sanitizedRepair })}\n\n`);
                console.log(`[repair] Semantic repair generated: ${sanitizedRepair.length} chars`);
              }
            }).catch(() => { /* fire-and-forget */ });
          } else if (semanticVerdict?.is_correct) {
            console.log('[semantic-judge] PASSED');
          }
        } catch (verifyErr: unknown) {
          console.warn('[verification] Verifier error:', (verifyErr as Error).message);
        }
      }

      // Emit done event after verifier + semantic repair so repair results
      // arrive BEFORE done on the frontend. generate() already emitted done
      // internally — sequential reasoning path bypassed it and needs it here.
      if (!isPassthrough && (routingDecision?.complexityScore ?? 0) >= 4 && routingDecision?.routingState !== 'manual') {
        res.write('event: done\ndata: {}\n\n');
      }

      // 13. After streaming: store assistant message
      if (result.assistantText) {
        try {
          const sanitizedAssistant = mask(result.assistantText).maskedText;
          await storeMessage(sessionId, 'assistant', sanitizedAssistant, {
            piiMasked: false,
            assistantSanitized: true,
          });
          // SUCCESS — increment turn count
          await incrementTurnCount(sessionId);

          // Extract structured facts from this turn (fire-and-forget)
          extractFacts(sessionId, maskedPrompt, sanitizedAssistant, memoryState.facts)
            .catch(() => { /* fire-and-forget */ });
        } catch (storeError: unknown) {
          // FAILURE — transition to degraded and emit SSE event
          console.error('[inference] Failed to store assistant message:', (storeError as Error).message);
          console.warn(`[inference] Session ${sessionId} transitioning to degraded state`);
          await transitionToDegraded(sessionId);
          res.write(`event: session_status\ndata: ${JSON.stringify({ sessionId, is_degraded: true })}\n\n`);
        }
      }

      // 13. Audit log (fire-and-forget)
      const durationMs = Date.now() - startTime;
      auditService.log({
        timestamp: new Date().toISOString(),
        userId: user.sub,
        username: user.username,
        modelId: resolveModelForInvocation(executedModelId),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        status: 'success',
        durationMs,
        passthrough: isPassthrough || undefined,
        routingState: routingDecision?.routingState,
        complexityScore: routingDecision?.complexityScore,
        routingReasonCode: routingDecision?.routingReasonCode,
        reasoningSummary: routingDecision?.reasoningSummary,
        executedModelId: routingDecision?.executedModelId,
        manualOverrideApplied: routingDecision?.manualOverrideApplied,
        routingFlags: routingDecision?.flags,
        sessionId,
        replayedMessageCount: contextOutput.historyMessageCount,
        contextTruncated: contextOutput.truncated,
        contextSummarized: false,
        orchestrationMeta,
        routingContext: routingDecision?.contract?.context,
        routingIntent: routingDecision?.contract?.intent,
        sessionContext: routingDecision?.sessionContext,
        knowledgeSourceIds: knowledgeChunks.map((c) => c.id),
        embeddingInputTokens,
      }).catch(() => { /* fire-and-forget */ });

      // 14. Memory update if messages were evicted (fire-and-forget)
      if (contextOutput.evictedMessages.length > 0) {
        summarizeEvicted(sessionId, contextOutput.evictedMessages, memoryState.summary)
          .catch(() => { /* fire-and-forget */ });
      }

      res.end();
    } catch (error: unknown) {
      // 14. On error, send SSE error event and close, then audit log failure
      const durationMs = Date.now() - startTime;
      let errorCategory = 'unknown';
      let errorMessage = 'An unexpected error occurred';

      if (error instanceof InferenceError) {
        errorCategory = error.category;
        errorMessage = error.message;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      console.error(`[inference] Generate failed after ${durationMs}ms: category=${errorCategory}, message=${errorMessage}`, error);

      // Send SSE error event
      res.write(`event: error\ndata: ${JSON.stringify({ error: errorCategory.toUpperCase(), message: errorMessage })}\n\n`);
      res.end();

      // Audit log the failure with routing metadata (fire-and-forget)
      auditService.log({
        timestamp: new Date().toISOString(),
        userId: user.sub,
        username: user.username,
        modelId: resolveModelForInvocation(executedModelId),
        inputTokens: 0,
        outputTokens: 0,
        status: 'failed',
        errorCategory,
        durationMs,
        routingState: routingDecision?.routingState,
        complexityScore: routingDecision?.complexityScore,
        routingReasonCode: routingDecision?.routingReasonCode,
        reasoningSummary: routingDecision?.reasoningSummary,
        executedModelId: routingDecision?.executedModelId,
        manualOverrideApplied: routingDecision?.manualOverrideApplied,
        routingFlags: routingDecision?.flags,
        sessionId,
        replayedMessageCount: contextOutput.historyMessageCount,
        contextTruncated: contextOutput.truncated,
        contextSummarized: false,
        orchestrationMeta,
        routingContext: routingDecision?.contract?.context,
        routingIntent: routingDecision?.contract?.intent,
        sessionContext: routingDecision?.sessionContext,
      }).catch(() => { /* fire-and-forget */ });
    }
  } finally {
    // GUARANTEED: Release the turn lock regardless of how the function exits
    await release().catch(() => {});
  }
}

/**
 * Handle multipart/form-data inference requests with file uploads.
 *
 * Turn lifecycle (mirrors handleJsonInference):
 *   1. Parse multipart with uploadMiddleware (multer)
 *   2. Extract form fields: prompt, modelId, config
 *   3. Validate and classify uploaded files
 *   4. Check model compatibility (images require vision model)
 *   5. Extract document text
 *   6. Mask prompt and extracted text with PII masker
 *   7. Prompt-too-large pre-check
 *   8. Validate session (catch SessionExpiredError / SessionNotFoundError)
 *   9. Acquire turn lock → 10. Save user message (fail-fast)
 *   → 11. Build context with buildContext() → 12. Stream AI response
 *   → 13. Save assistant message (increment turn count or degrade on failure)
 *   → 14. Release lock
 *
 * @see Requirements 2.1, 2.2, 2.3, 2.4, 1.3, 1.4, 1.6, 3.1, 4.1
 */
async function handleMultipartInference(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Step 1: Apply uploadMiddleware to parse multipart/form-data
  await new Promise<void>((resolve, reject) => {
    uploadMiddleware(req, res, (err?: unknown) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  }).catch((err: unknown) => {
    // Delegate multer errors to the error handler middleware
    multerErrorHandler(err as Error, req, res, next);
    return;
  });

  // If the response has already been sent (multer error), stop processing
  if (res.headersSent) return;

  const startTime = Date.now();
  const user = req.user!;

  // Step 2: Extract form fields
  const prompt = req.body.prompt as string | undefined;
  const modelId = req.body.modelId as string | undefined;
  let inferenceConfig: { maxTokens?: number; temperature?: number; topP?: number } | undefined;

  if (req.body.config) {
    try {
      inferenceConfig = typeof req.body.config === 'string'
        ? JSON.parse(req.body.config)
        : req.body.config;
    } catch {
      res.status(400).json({
        error: 'INVALID_CONFIG',
        message: 'Config must be a valid JSON object',
      });
      return;
    }
  }

  // Step 2b: Validate modelId (async — checks private model access)
  let validatedModelId: string;
  try {
    validatedModelId = await validateModelId(modelId, user.sub);
  } catch (error: unknown) {
    const err = error as Error & { code?: string; statusCode?: number };
    res.status(err.statusCode ?? 400).json({
      error: err.code ?? 'INVALID_MODEL',
      message: err.message,
    });
    return;
  }

  // Step 3: Validate and classify uploaded files
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) {
    // No files and no prompt → reject
    if (!prompt || prompt.trim().length === 0) {
      res.status(400).json({
        error: 'EMPTY_REQUEST',
        message: 'At least one input is required: text prompt or file attachment',
      });
      return;
    }
  }

  let validatedUpload;
  if (files && files.length > 0) {
    try {
      validatedUpload = validateAndClassifyFiles(files);
    } catch (error: unknown) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: (error as Error).message,
      });
      return;
    }
  }

  const documents = validatedUpload?.documents ?? [];
  const images = validatedUpload?.images ?? [];

  // Step 4: Check model compatibility — images require a vision model
  if (images.length > 0 && !supportsImages(validatedModelId)) {
    const visionModels = getVisionModels();
    res.status(400).json({
      error: 'MODEL_NO_VISION',
      message: `Model '${validatedModelId}' does not support image inputs. Vision-capable models: ${visionModels.join(', ')}`,
    });
    return;
  }

  // Step 5: Extract document text
  const documentExtractions: Array<{ text: string; filename: string; confidence: 'high' | 'medium' | 'low' }> = [];
  try {
    for (const doc of documents) {
      const extraction = await extractDocumentText(doc);
      documentExtractions.push({
        text: extraction.text,
        filename: extraction.filename,
        confidence: extraction.confidence,
      });
    }
  } catch (error: unknown) {
    res.status(422).json({
      error: 'DOCUMENT_PARSE_ERROR',
      message: (error as Error).message,
    });
    return;
  }

  // Step 6: Mask prompt and extracted document texts
  // Use default prompt if none provided (Requirement 1.7)
  const effectivePrompt = (prompt && prompt.trim().length > 0)
    ? prompt
    : 'Analyze the attached content.';

  let maskedPrompt: string;
  try {
    const maskResult = mask(effectivePrompt);
    maskedPrompt = maskResult.maskedText;
  } catch {
    res.status(500).json({
      error: 'MASKING_ERROR',
      message: 'Failed to process prompt. Please try again.',
    });
    return;
  }

  // Mask each document's extracted text (Requirement 2.5)
  const maskedDocumentExtractions: Array<{ text: string; filename: string }> = [];
  try {
    for (const doc of documentExtractions) {
      if (doc.text) {
        const maskResult = mask(doc.text);
        maskedDocumentExtractions.push({
          text: maskResult.maskedText,
          filename: doc.filename,
        });
      } else {
        maskedDocumentExtractions.push(doc);
      }
    }
  } catch {
    res.status(500).json({
      error: 'MASKING_ERROR',
      message: 'Failed to process document text. Please try again.',
    });
    return;
  }

  // Step 7: Prompt-too-large pre-check against session context character budget
  if (maskedPrompt.length > config.session.maxContextCharacters) {
    res.status(413).json({
      error: 'PROMPT_TOO_LARGE',
      message: 'Prompt exceeds maximum allowed length.',
    });
    return;
  }

  // Step 8: Validate session — catch SessionExpiredError / SessionNotFoundError
  let sessionId: string;
  try {
    const session = await getValidatedSession(user.sub, req.body.sessionId);
    sessionId = session.id;
  } catch (sessionError: unknown) {
    if (sessionError instanceof SessionExpiredError) {
      // Set SSE headers and emit error event
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'SESSION_EXPIRED', message: 'Session expired' })}\n\n`);
      res.end();
      return;
    }
    if (sessionError instanceof SessionNotFoundError) {
      res.status(404).json({
        error: 'SESSION_NOT_FOUND',
        message: 'Session not found',
      });
      return;
    }
    // Unexpected session error
    console.error('[inference-multipart] Session validation failed:', (sessionError as Error).message);
    res.status(500).json({
      error: 'SESSION_ERROR',
      message: 'Failed to validate session',
    });
    return;
  }

  // Step 9: Turn lock — prevent concurrent turns on the same session (distributed via PostgreSQL)
  const { locked: acquired, release } = await tryAcquireSessionLock(sessionId);
  if (!acquired) {
    res.status(409).json({
      error: 'TURN_IN_PROGRESS',
      message: 'Please wait for the current response to finish.',
    });
    return;
  }

  try {
    // Step 10: Store user message — FAIL-FAST: if it throws, do NOT call AI
    // Store only the masked TEXT prompt (not file content) — files are ephemeral per request
    try {
      await storeMessage(sessionId, 'user', maskedPrompt, { piiMasked: true });
    } catch (storeError: unknown) {
      console.error('[inference-multipart] Failed to store user message:', (storeError as Error).message);
      res.status(500).json({
        error: 'PERSISTENCE_ERROR',
        message: 'Failed to save message. Please try again.',
      });
      return;
    }

    // Step 11: Fetch session messages and build context using unified buildContext()
    const allMessages = await getSessionMessages(sessionId);
    const historyMessages = allMessages.slice(0, -1); // Exclude the just-stored current user message

    // Load session memory for rolling summary injection
    const memoryState = await loadMemoryState(sessionId);

    const contextConfig: ContextConfig = {
      maxHistoryMessages: config.session.maxHistoryTurns * 2,
      maxContextCharacters: config.session.maxContextCharacters,
      memoryState,
    };

    const contextOutput = buildContext(historyMessages, maskedPrompt, contextConfig);

  // Step 12: Determine routing state and execute routing logic
  const routingState: 'auto' | 'manual' = (!modelId || modelId.trim().length === 0) ? 'auto' : 'manual';

  let executedModelId: string = validatedModelId;
  let routingEffectivePrompt: string = maskedPrompt;
  let routingDecision: RoutingDecision | undefined;

  // Combine masked document texts for routing context
  const maskedDocTextCombined = maskedDocumentExtractions.map(d => d.text).filter(Boolean).join('\n');

  if (routingState === 'auto') {
    // Use routing_payload from contextOutput as conversation context
    const conversationContext = contextOutput.routing_payload;

    // Build routing input for auto routing (multimodal-aware)
    const routingInput: RoutingInput = {
      originalPrompt: maskedPrompt,
      maskedDocumentText: maskedDocTextCombined || undefined,
      hasImages: images.length > 0,
      imageModelRequired: images.length > 0,
      routingState: 'auto',
      userId: user.sub,
      conversationContext,
    };

    try {
      routingDecision = await routeRequest(routingInput);
      executedModelId = routingDecision.executedModelId;
      routingEffectivePrompt = routingDecision.refinedPrompt;
    } catch (routingError: unknown) {
      // Routing engine failure: fallback to DEFAULT_MODEL, log warning
      executedModelId = DEFAULT_MODEL;
      console.warn('[routing-fallback] Routing engine failed, falling back to default model:', (routingError as Error).message);
      routingDecision = {
        executedModelId: DEFAULT_MODEL,
        routingState: 'auto',
        complexityScore: 2,
        scoreBand: 'direct-answer',
        confidence: 0,
        refinedPrompt: maskedPrompt,
        routingReasonCode: 'routing-fallback',
        reasoningSummary: 'Routing engine failed, using default model',
        modalityFlags: {
          textOnly: images.length === 0 && documents.length === 0,
          documentText: documents.length > 0 && images.length === 0,
          image: images.length > 0 && documents.length === 0,
          mixed: images.length > 0 && documents.length > 0,
        },
        manualOverrideApplied: false,
        flags: ['routing-fallback'],
        skill: 'fallback',
        contract: null,
      };
    }
  } else {
    // Manual state: use user-selected model (validation already done in step 4 for images)
    routingDecision = {
      executedModelId: validatedModelId,
      routingState: 'manual',
      complexityScore: 0,
      scoreBand: 'direct-answer',
      confidence: 1.0,
      refinedPrompt: maskedPrompt,
      routingReasonCode: 'manual-override',
      reasoningSummary: `Manual routing: user selected model ${validatedModelId}`,
      modalityFlags: {
        textOnly: images.length === 0 && documents.length === 0,
        documentText: documents.length > 0 && images.length === 0,
        image: images.length > 0 && documents.length === 0,
        mixed: images.length > 0 && documents.length > 0,
      },
      manualOverrideApplied: true,
      flags: [],
      skill: 'fallback',
      contract: null,
    };
  }

  // Step 7: Process images into content blocks
  const imageBlocks = processImages(images);

  // Build document blocks for OCR fallback when extraction confidence is low.
  // Low confidence means the extractor judged text content as too sparse (e.g.
  // image-based PDF, PPTX with only titles, HTML with no body text).
  // The raw document buffer is sent to Nova Lite for OCR extraction.
  const documentBlocks: DocumentContentBlock[] = [];
  for (const doc of documents) {
    const extraction = documentExtractions.find(e => e.filename === doc.originalname);
    if (extraction && extraction.confidence === 'low') {
      // Text extraction returned empty — include raw document for Nova OCR
      const format = doc.mimetype === 'application/pdf' ? 'pdf' as const : 'docx' as const;
      documentBlocks.push({
        document: {
          format,
          name: doc.originalname,
          source: { bytes: doc.buffer.toString('base64') },
        },
      });
    }
  }

  // Determine if OCR pipeline is needed
  const needsOCR = images.length > 0 || documentBlocks.length > 0;

  // Step 8: Build content blocks (use refined prompt from routing if available)
  let contentBlocks: ContentBlock[];
  try {
    contentBlocks = buildContentBlocks({
      maskedPrompt: routingEffectivePrompt,
      documentExtractions: maskedDocumentExtractions,
      imageBlocks,
      documentBlocks,
    });
  } catch (error: unknown) {
    res.status(400).json({
      error: 'EMPTY_REQUEST',
      message: (error as Error).message,
    });
    return;
  }

  // ── Two-stage OCR pipeline ──────────────────────────────────────────
  // When images or unparseable documents are present:
  //   Stage 1: Nova 2 Lite extracts/OCR the visual content (via inference profile)
  //   Stage 2: GPT-OSS 120B enhances the extracted text with reasoning
  // Falls back to GPT-OSS 120B if Nova OCR fails (it supports images natively).
  const ENHANCE_MODEL = 'openai.gpt-oss-120b-1:0';

  let ocrText: string | undefined;
  let finalExecutedModelId = executedModelId;

  // Inject ambiguities into prompt if contract flagged them (multipart)
  if (routingDecision?.contract?.clarificationNeeded && routingDecision?.contract?.ambiguities?.length > 0) {
    const ambigNote = '\n\nNote: The following aspects of my request may be unclear. Please address them if possible:\n- ' + routingDecision.contract.ambiguities.join('\n- ');
    routingEffectivePrompt += ambigNote;
  }

  // Use inference_payload from buildContext() for history, exclude the last message
  const inferenceMessages: BedrockMessage[] = contextOutput.inference_payload.slice(0, -1);

  // The current user message includes text + documents + images as content blocks
  let currentUserContent: Array<{ text: string } | { image: any } | { document: any }> = contentBlocks.map(block => {
    if ('text' in block) {
      return { text: block.text };
    }
    if ('image' in block) {
      return { image: (block as any).image };
    }
    return { document: (block as any).document };
  });

  let currentUserMessage: BedrockMessage = {
    role: 'user',
    content: currentUserContent as Array<{ text: string }>,
  };

  let conversationMessages: BedrockMessage[] = [
    ...inferenceMessages,
    currentUserMessage,
  ];

  if (needsOCR) {
    try {
      console.log(`[inference] Two-stage OCR pipeline: ${NOVA_LITE_MODEL} → ${ENHANCE_MODEL}`);

      // Stage 1: Nova Lite extracts image/document content via raw InvokeModel API
      // Build Messages API payload from history + current user content blocks
      const ocrMessages = [
        ...inferenceMessages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: currentUserContent },
      ];

      const ocrStart = Date.now();
      ocrText = await invokeNovaForOCR(ocrMessages, 4096);
      const ocrDuration = Date.now() - ocrStart;
      console.log(`[inference] OCR stage complete in ${ocrDuration}ms, output ${ocrText.length} chars`);

      if (ocrText.trim().length > 0) {
        // Stage 2: GPT-OSS enhances the OCR output
        finalExecutedModelId = ENHANCE_MODEL;

        const enhancedPrompt = [
          `Original request: ${routingEffectivePrompt}`,
          '',
          `Content extracted from uploaded file(s):`,
          ocrText,
          '',
          'Please provide a comprehensive response incorporating the extracted content above.',
        ].join('\n');

        currentUserContent = [{ text: enhancedPrompt }];
        currentUserMessage = { role: 'user', content: currentUserContent as Array<{ text: string }> };
        conversationMessages = [...inferenceMessages, currentUserMessage];

        console.log(`[inference] Stage 2: enhancing OCR output with ${ENHANCE_MODEL}, enhanced prompt ${enhancedPrompt.length} chars`);
      } else {
        // OCR returned empty — fall back to GPT-OSS (native image support)
        console.warn('[inference] OCR returned empty text, falling back to direct vision model');
        finalExecutedModelId = ENHANCE_MODEL;
      }
    } catch (ocrError: unknown) {
      // OCR failed — fall back to GPT-OSS which supports images natively
      console.warn('[inference] OCR stage failed, falling back to direct vision model:', (ocrError as Error).message);
      finalExecutedModelId = ENHANCE_MODEL;
    }
  }

  // Use OCR-extracted text as effective document content when available.
  // The document extractor may return empty for image-heavy files (PPTX, scanned PDFs)
  // while the OCR pipeline extracts the real content. Without this override, the
  // orchestrator (sub-agent or sequential reasoning) receives empty context.
  const effectiveDocText = ocrText && ocrText.trim().length > 0
    ? ocrText.slice(0, config.orchestration.largeDocumentThreshold)
    : (maskedDocTextCombined || undefined);

  // Step 14: Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Step 14b: Emit session SSE event with sessionId for frontend
  res.write(`event: session\ndata: ${JSON.stringify({ sessionId })}\n\n`);

  // Step 14c: Emit routing metadata SSE event if enabled
  if (config.routing.metadataEnabled && routingDecision) {
    const routingMetadata: RoutingMetadataEvent = {
      refinedPrompt: routingDecision.refinedPrompt,
      complexityScore: routingDecision.complexityScore,
      scoreBand: routingDecision.scoreBand,
      routingState: routingDecision.routingState,
      executedModelId: finalExecutedModelId,
      routingReasonCode: needsOCR ? 'ocr-two-stage' : routingDecision.routingReasonCode,
      reasoningSummary: needsOCR
        ? `Two-stage OCR: ${NOVA_LITE_MODEL} extracted content, ${ENHANCE_MODEL} enhanced response`
        : routingDecision.reasoningSummary,
      modalityFlags: routingDecision.modalityFlags,
      manualOverrideApplied: routingDecision.manualOverrideApplied,
      skill: routingDecision.skill,
      contract: routingDecision.contract as Record<string, unknown> | null | undefined,

      // Confidence & flags
      confidence: routingDecision.confidence,
      flags: routingDecision.flags,

      // Timing (ms per routing step)
      routingDurationMs: routingDecision.routingDurationMs,
      classificationDurationMs: routingDecision.classificationDurationMs,
      refinementDurationMs: routingDecision.refinementDurationMs,
      scoringDurationMs: routingDecision.scoringDurationMs,

      // Prompt info
      originalPromptLength: maskedPrompt.length,
      promptLengthAfterRefinement: routingEffectivePrompt.length,

      // Conversation context
      conversationContext: contextOutput.routing_payload,
      historyMessageCount: contextOutput.historyMessageCount,
      contextTruncated: contextOutput.truncated,

      // Session memory
      memorySummary: memoryState.summary ?? undefined,
      memoryVersion: memoryState.memoryVersion,
      memoryFacts: memoryState.facts,

      // Two-stage OCR info
      ocrExecuted: needsOCR || undefined,
      ocrModel: needsOCR ? NOVA_LITE_MODEL : undefined,
      enhanceModel: needsOCR ? ENHANCE_MODEL : undefined,
      // Raw LLM call data for debugging
      _classificationRaw: (routingDecision as any)?._classRaw,
      _classificationPrompt: (routingDecision as any)?._classPrompt,
      _refinementRaw: (routingDecision as any)?._refineRaw,
      _refinementPrompt: (routingDecision as any)?._refinePrompt,
    };
    res.write(`event: routing\ndata: ${JSON.stringify(routingMetadata)}\n\n`);
  }

  // Inject skill-specific few-shot examples for format adherence
  const fewShotPairsMP = getFewShotExamples(routingDecision?.skill || 'fallback');
  if (fewShotPairsMP.length > 0) {
    // Insert before the current user message, after history + OCR output
    const lastMsg = conversationMessages.pop()!;
    conversationMessages.push(...fewShotPairsMP, lastMsg);
  }

  // Step 15: Call generate (streams enhance model or original model)
  // If OCR switched to enhance model, fall back to original routing model on failure
  let result: ConversationInferenceResult | undefined;
  let orchestrationMeta: any;
  const targetModel = resolveModelForInvocation(finalExecutedModelId);
  const fallbackModel = executedModelId !== finalExecutedModelId ? resolveModelForInvocation(executedModelId) : null;

  try {  // middle try — wraps generate, verifier, storage, audit; catch is main error handler below

  // ── Unified Execution Branch ───────────────────────────────────
  // Sequential reasoning for complex queries (≥4), single-shot otherwise
  if (!result && (routingDecision?.complexityScore ?? 0) >= 4 && routingDecision?.routingState !== 'manual') {
    const seqInput = {
      originalPrompt: maskedPrompt,
      refinedPrompt: routingEffectivePrompt,
      maskedDocumentText: effectiveDocText,
      conversationHistory: inferenceMessages,
      userId: user.sub,
      sessionId,
      username: user.username,
      routingDecision,
    };
    console.log(`[inference-multipart] Sequential reasoning triggered: complexity=${routingDecision.complexityScore}, calling SequentialReasoner`);
    const seqResult = await sequentialReasoner.execute(seqInput, res);

    if (seqResult) {
      console.log(`[inference-multipart] Sequential reasoning complete: ${seqResult.assistantText.length} chars, ${seqResult.stepResults.filter(r => r.status === 'success').length}/${seqResult.stepResults.length} steps`);
      orchestrationMeta = seqResult.orchestrationMeta as any;
      result = {
        assistantText: seqResult.assistantText,
        inputTokens: seqResult.orchestrationMeta.totalInputTokens,
        outputTokens: seqResult.orchestrationMeta.totalOutputTokens,
        modelId: finalExecutedModelId,
        status: 'success',
      };
    } else {
      console.log('[inference-multipart] Sequential reasoning plan failed, falling back to standard generate');
    }
  }

  if (!result) {
    try {
      const conversationRequest: ConversationInferenceRequest = {
        messages: conversationMessages,
        modelId: targetModel,
        userId: user.sub,
        system: (() => {
        const role = routingDecision?.contract?.role || getRoleForSkill(routingDecision?.skill || 'fallback');
        const lang = routingDecision?.detectedLanguage || 'indonesian';
        const bi = routingDecision?.contract?.behavioral_instructions;
        const skill = routingDecision?.skill || 'fallback';
        // Use deterministic template if available (preferred), fall back to legacy dynamic output_format
        const formatTemplate = getDefaultFormatTemplate(skill) || routingDecision?.contract?.output_format;
        let s = 'You are ' + role + '. Respond in ' + lang + '.';
        if (bi) s += '\n\n' + bi;
        if (formatTemplate) {
          s += '\n\nFollow this output structure:\n' + formatTemplate;
        }
        // Grounding: prevent hallucination by anchoring to provided context
        s += '\n\nIf the user provides documents or data, base your answer strictly on that material. If asked about something not covered in the provided information, say "Informasi ini tidak tersedia dalam dokumen yang diberikan" instead of guessing. For facts, numbers, and regulations, do not fabricate — state your uncertainty if unsure.';
        return s;
      })(),
        ...(inferenceConfig && {
          inferenceConfig: {
            maxTokens: inferenceConfig.maxTokens,
            temperature: inferenceConfig.temperature,
            topP: inferenceConfig.topP,
          },
        }),
      };
      result = await generate(conversationRequest, res) as ConversationInferenceResult;
    } catch (firstErr: unknown) {
      if (fallbackModel && fallbackModel !== targetModel) {
        console.warn(`[inference-multipart] ${targetModel} failed, falling back to ${fallbackModel}:`, (firstErr as Error).message);
        const fallbackRequest: ConversationInferenceRequest = {
          messages: conversationMessages,
          modelId: fallbackModel,
          userId: user.sub,
          ...(inferenceConfig && {
            inferenceConfig: {
              maxTokens: inferenceConfig.maxTokens,
              temperature: inferenceConfig.temperature,
              topP: inferenceConfig.topP,
            },
          }),
        };
        result = await generate(fallbackRequest, res) as ConversationInferenceResult;
        finalExecutedModelId = executedModelId;
        console.log(`[inference-multipart] Fallback to ${fallbackModel} succeeded`);
      } else {
        throw firstErr;
      }
    }
  }

  // Verifier + auto-repair for multipath handler
  if (routingDecision?.contract && result.assistantText) {
      try {
        const verification = verifyOutput(routingDecision.contract, result.assistantText);
        res.write(`event: verification\ndata: ${JSON.stringify(verification)}\n\n`);
        console.log(`[verification] ${verification.passed ? 'PASSED' : 'FAILED'} — ${verification.violations.length} violations`);

        if (!verification.passed && verification.violations.filter(v => v.severity === 'error').length > 0) {
          const repairMessages = conversationMessages.map(msg => ({
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
          }));
          repairResponse(
            finalExecutedModelId,
            repairMessages,
            verification.violations,
          ).then(repairText => {
            if (repairText) {
              const sanitizedRepair = mask(repairText).maskedText;
              res.write(`event: repair\ndata: ${JSON.stringify({ text: sanitizedRepair })}\n\n`);
              console.log(`[repair] Auto-repair generated: ${sanitizedRepair.length} chars`);
            }
          }).catch(() => { /* fire-and-forget */ });
        }

        // Semantic verification (LLM-as-a-judge) for high-stakes skills
        const semanticVerdict = await semanticJudge(
          maskedPrompt,
          result.assistantText,
          routingDecision?.skill || 'fallback',
        );
        if (semanticVerdict && !semanticVerdict.is_correct && semanticVerdict.missing_elements.length > 0) {
          res.write(`event: semantic_verdict\ndata: ${JSON.stringify(semanticVerdict)}\n\n`);
          console.log(`[semantic-judge] FAILED — ${semanticVerdict.missing_elements.length} missing elements`);

          const semRepairMessages = conversationMessages.map(msg => ({
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
          }));
          repairResponse(
            finalExecutedModelId,
            semRepairMessages,
            semanticVerdict.missing_elements.map(m => ({
              field: 'semantic', issue: m, severity: 'error' as const,
            })),
          ).then(repairText => {
            if (repairText) {
              const sanitizedRepair = mask(repairText).maskedText;
              res.write(`event: repair\ndata: ${JSON.stringify({ text: sanitizedRepair })}\n\n`);
              console.log(`[repair] Semantic repair generated: ${sanitizedRepair.length} chars`);
            }
          }).catch(() => { /* fire-and-forget */ });
        } else if (semanticVerdict?.is_correct) {
          console.log('[semantic-judge] PASSED');
        }
      } catch (verifyErr: unknown) {
        console.warn('[verification] Verifier error:', (verifyErr as Error).message);
      }
    }

    // Emit done after verifier + repair so repair events arrive before done
    if ((routingDecision?.complexityScore ?? 0) >= 4 && routingDecision?.routingState !== 'manual') {
      res.write('event: done\ndata: {}\n\n');
    }

    // Step 16: After streaming: store assistant message
    if (result.assistantText) {
      try {
        const sanitizedAssistant = mask(result.assistantText).maskedText;
        await storeMessage(sessionId, 'assistant', sanitizedAssistant, {
          piiMasked: false,
          assistantSanitized: true,
        });
        // SUCCESS — increment turn count
        await incrementTurnCount(sessionId);

        // Extract structured facts from this turn (fire-and-forget)
        extractFacts(sessionId, maskedPrompt, sanitizedAssistant, memoryState.facts)
          .catch(() => { /* fire-and-forget */ });
      } catch (storeError: unknown) {
        // FAILURE — transition to degraded and emit SSE event
        console.error('[inference-multipart] Failed to store assistant message:', (storeError as Error).message);
        console.warn(`[inference-multipart] Session ${sessionId} transitioning to degraded state`);
        await transitionToDegraded(sessionId);
        res.write(`event: session_status\ndata: ${JSON.stringify({ sessionId, is_degraded: true })}\n\n`);
      }
    }

    // Step 17: Audit log with file metadata and routing metadata (fire-and-forget)
    const durationMs = Date.now() - startTime;
    auditService.log({
      timestamp: new Date().toISOString(),
      userId: user.sub,
      username: user.username,
      modelId: finalExecutedModelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      status: 'success',
      durationMs,
      // File metadata for multimodal requests
      fileCount: validatedUpload?.fileCount,
      fileMimeTypes: validatedUpload?.mimeTypes,
      totalFileSize: validatedUpload?.totalSize,
      isMultimodal: true,
      // Routing metadata
      routingState: routingDecision?.routingState,
      complexityScore: routingDecision?.complexityScore,
      routingReasonCode: needsOCR ? 'ocr-two-stage' : routingDecision?.routingReasonCode,
      reasoningSummary: routingDecision?.reasoningSummary,
      executedModelId: routingDecision?.executedModelId,
      manualOverrideApplied: routingDecision?.manualOverrideApplied,
      routingFlags: routingDecision?.flags,
      // Session metadata
      sessionId,
      replayedMessageCount: contextOutput.historyMessageCount,
      contextTruncated: contextOutput.truncated,
      contextSummarized: false,
      orchestrationMeta,
      routingContext: routingDecision?.contract?.context,
      routingIntent: routingDecision?.contract?.intent,
    }).catch(() => { /* fire-and-forget */ });

    // Memory update if messages were evicted (fire-and-forget)
    if (contextOutput.evictedMessages.length > 0) {
      summarizeEvicted(sessionId, contextOutput.evictedMessages, memoryState.summary)
        .catch(() => { /* fire-and-forget */ });
    }

  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    let errorCategory = 'unknown';
    let errorMessage = 'An unexpected error occurred';

    if (error instanceof InferenceError) {
      errorCategory = error.category;
      errorMessage = error.message;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    console.error(`[inference-multipart] Generate failed after ${durationMs}ms: category=${errorCategory}, message=${errorMessage}`, error);

    // Send SSE error event
    res.write(`event: error\ndata: ${JSON.stringify({ error: errorCategory.toUpperCase(), message: errorMessage })}\n\n`);
    res.end();

    // Audit log the failure with file metadata and routing metadata (fire-and-forget)
    auditService.log({
      timestamp: new Date().toISOString(),
      userId: user.sub,
      username: user.username,
      modelId: finalExecutedModelId,
      inputTokens: 0,
      outputTokens: 0,
      status: 'failed',
      errorCategory,
      durationMs,
      fileCount: validatedUpload?.fileCount,
      fileMimeTypes: validatedUpload?.mimeTypes,
      totalFileSize: validatedUpload?.totalSize,
      isMultimodal: true,
      // Routing metadata
      routingState: routingDecision?.routingState,
      complexityScore: routingDecision?.complexityScore,
      routingReasonCode: needsOCR ? 'ocr-two-stage' : routingDecision?.routingReasonCode,
      reasoningSummary: routingDecision?.reasoningSummary,
      executedModelId: routingDecision?.executedModelId,
      manualOverrideApplied: routingDecision?.manualOverrideApplied,
      routingFlags: routingDecision?.flags,
      // Session metadata
      sessionId,
      replayedMessageCount: contextOutput.historyMessageCount,
      contextTruncated: contextOutput.truncated,
      contextSummarized: false,
      orchestrationMeta,
      routingContext: routingDecision?.contract?.context,
      routingIntent: routingDecision?.contract?.intent,
    }).catch(() => { /* fire-and-forget */ });
  } finally {
    // Memory cleanup: release file buffers
    if (files) {
      for (const file of files) {
        (file as any).buffer = null;
      }
    }
  }
  } finally {
    // GUARANTEED: Release the turn lock regardless of how the function exits
    await release().catch(() => {});
  }
}

/**
 * POST /sessions/reset
 *
 * Marks the authenticated user's active session as inactive.
 * Returns HTTP 200 `{ success: true }` — idempotent (succeeds even if no active session exists).
 *
 * @see Requirements 8.5, 8.6
 */
inferenceRouter.post('/sessions/reset', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;

  try {
    const session = await getActiveSession(user.sub);

    if (session) {
      await markSessionInactive(session.id);
    }

    res.status(200).json({ success: true });
  } catch (error: unknown) {
    console.error('[sessions/reset] Failed to reset session:', (error as Error).message);
    res.status(500).json({
      error: 'SESSION_ERROR',
      message: 'Failed to reset session',
    });
  }
});

// ── Batch Output Parsing Helpers ─────────────────────────────

function tryParseJSON(text: string): Record<string, unknown> | null {
  // Strip ```json fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const parsed = JSON.parse(cleaned);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function asStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  return [];
}

function asActionItems(val: unknown): Array<{ task: string; owner?: string }> {
  if (!Array.isArray(val)) return [];
  return val.map((item: unknown) => {
    if (typeof item === 'string') return { task: item };
    if (typeof item === 'object' && item !== null) {
      const o = item as Record<string, unknown>;
      return {
        task: String(o.task ?? o.Task ?? ''),
        owner: (o.owner ?? o.Owner ?? undefined) as string | undefined,
      };
    }
    return { task: String(item) };
  }).filter((a) => a.task.length > 0);
}

/**
 * Fallback: extract structured data from markdown output.
 * Handles models that ignore response_format: json_object.
 */
function extractFromMarkdown(text: string): { summary: string; decisions: string[]; actionItems: Array<{ task: string; owner?: string }> } | null {
  // Try to find summary section
  const summaryMatch = text.match(/\*\*SUMMARY:?\*\*\s*\n?([\s\S]*?)(?=\*\*DECISIONS|\*\*ACTION|$)/i)
    ?? text.match(/(?:^|\n)(?:Executive\s*)?Summary:?\s*\n?([\s\S]*?)(?=\n(?:Key\s*)?Decisions?:|\n(?:Key\s*)?Action\s*(?:Items|Plan)?:|\n\*\*|$)/im);
  const summary = (summaryMatch?.[1] ?? text.split('\n\n')[0]).trim();

  // Extract decisions — bullet or numbered lists after DECISIONS header
  const decisionsBlock = text.match(/\*\*DECISIONS?:?\*\*\s*\n?([\s\S]*?)(?=\*\*ACTION|\*\*NEXT|$)/i)
    ?? text.match(/(?:^|\n)(?:Key\s*)?Decisions?:?\s*\n([\s\S]*?)(?=\n(?:Key\s*)?Action\s*(?:Items|Plan)?:|\n\*\*|$)/im);
  const decisions: string[] = [];
  if (decisionsBlock?.[1]) {
    const lines = decisionsBlock[1].split('\n').filter(Boolean);
    for (const line of lines) {
      const cleaned = line.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '').trim();
      if (cleaned && cleaned.length > 5) decisions.push(cleaned);
    }
  }

  // Extract action items
  const actionsBlock = text.match(/\*\*ACTION\s*(?:ITEMS?|PLAN)?:?\*\*\s*\n?([\s\S]*?)(?=\n\*\*|$)/i)
    ?? text.match(/(?:^|\n)(?:Key\s*)?Action\s*(?:Items|Plan)?:?\s*\n([\s\S]*?)$/im);
  const actionItems: Array<{ task: string; owner?: string }> = [];
  if (actionsBlock?.[1]) {
    const lines = actionsBlock[1].split('\n').filter(Boolean);
    for (const line of lines) {
      let cleaned = line.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '').trim();
      if (!cleaned || cleaned.length < 5) continue;
      // Try to extract owner: "Task — Owner" or "Task (Owner)" or "Owner: Task"
      let owner: string | undefined;
      const ownerMatch = cleaned.match(/[-—–]\s*([^—-]+)$/);
      if (ownerMatch) {
        owner = ownerMatch[1].trim();
        cleaned = cleaned.slice(0, ownerMatch.index!).trim();
      } else {
        const parenMatch = cleaned.match(/\(([^)]+)\)$/);
        if (parenMatch) {
          owner = parenMatch[1].trim();
          cleaned = cleaned.slice(0, parenMatch.index!).trim();
        }
      }
      if (cleaned) actionItems.push({ task: cleaned, owner });
    }
  }

  return { summary, decisions, actionItems };
}
