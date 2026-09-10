import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { authMiddleware, apiKeyAuthMiddleware } from '../middleware/auth.middleware.js';
import { forcePasswordResetMiddleware } from '../middleware/password-reset.middleware.js';
import { inferenceRateLimit } from '../middleware/security.middleware.js';
import { uploadMiddleware, multerErrorHandler } from '../middleware/upload.middleware.js';
import { mask } from '../services/pii-masker.service.js';
import { validateModelId, generate, invokeNovaForOCR, InferenceError } from '../services/inference.service.js';
import { validateAndClassifyFiles } from '../services/upload-validator.service.js';
import { supportsImages, getVisionModels } from '../config/model-capabilities.js';
import { extractDocumentText } from '../services/document-extractor.service.js';
import { processImages } from '../services/image-processor.service.js';
import { buildContentBlocks } from '../services/content-builder.service.js';
import { auditService } from '../services/audit.service.js';
import { configService } from '../services/config.service.js';
import { routeRequest } from '../services/routing-engine.service.js';
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
  setInternalDocumentContext,
} from '../services/session.service.js';
import { buildContext, buildKnowledgeSection } from '../services/context-assembly.service.js';
import type { ContextConfig } from '../services/context-assembly.service.js';
import { search as knowledgeSearch } from '../services/knowledge.service.js';
import { streamExternalCompletion } from '../services/external-chat.service.js';
import { AVAILABLE_TOOLS } from '../services/tool-registry.service.js';
import { TIER1_TOOLS, execTier1Tool } from '../services/tier1-tools.service.js';
import { getDefaultTier3Model } from '../services/tier3.service.js';
import { tryAcquireSessionLock } from '../config/database.js';
import { loadMemoryState, summarizeEvicted, extractFacts } from '../services/session-memory.service.js';
import { config } from '../config/index.js';
import { getRoleForSkill } from '../config/skill-role-map.js';
import type { RoutingMetadataEvent } from '../types/inference.types.js';
import { DEFAULT_MODEL } from '../types/inference.types.js';
import type { RoutingInput, RoutingDecision } from '../types/routing.types.js';
import type { ContentBlock, DocumentContentBlock } from '../types/upload.types.js';
import type { ConversationInferenceRequest, ConversationInferenceResult, BedrockMessage } from '../types/session.types.js';
import { interceptUrls } from '../services/url-interceptor.service.js';
import {
  GoogleDriveNotAuthorizedError,
  GoogleDriveTokenRevokedError,
} from '../services/google-drive-token.service.js';

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

/** Select the system-prompt grounding clause for the current execution path.
 *  Internal turns (KB-grounded, or Tier-1 tool) anchor strictly to provided material.
 *  A sovereign-tier-3 external escalation must NOT get that clause: it fires only when
 *  retrieval is empty, so the internal doc-refusal text would make the external
 *  general-knowledge model refuse live/open questions (e.g. "berapa kurs dollar saat ini"
 *  answered "tidak tersedia dalam dokumen" instead of helping). External = general
 *  assistant, honest about real-time data it cannot reach — a general fix, not query-specific. */
export function buildGroundingClause(opts: { tier1ToolsOn: boolean; sovereignTier3: boolean }): string {
  if (opts.tier1ToolsOn) {
    return 'You have access to the search_internal_knowledge tool. Use it to search the internal ' +
      'knowledge base (SOP/kebijakan/prosedur perbankan, FAQ, memo) whenever the provided context ' +
      'is not enough to answer completely, or to follow a cross-reference. Call it BEFORE concluding ' +
      'that information is unavailable. Base your final answer strictly on the retrieved material and ' +
      'cite its source. For facts, numbers, and regulations, do not fabricate — state your uncertainty if unsure.';
  }
  if (opts.sovereignTier3) {
    return 'No internal document was retrieved for this question — answer from your own general ' +
      'knowledge, not as a document summarizer. For facts and figures, do not fabricate. If the question ' +
      'needs real-time data (exchange rates, prices, weather, breaking events) that you cannot access ' +
      'reliably, state that a live source is needed and name authoritative references (e.g. Bank Indonesia ' +
      '/ JISDOR for IDR rates) instead of inventing a number.';
  }
  return 'If the user provides documents or data, base your answer strictly on that material. If asked about something not covered in the provided information, say "Informasi ini tidak tersedia dalam dokumen yang diberikan" instead of guessing. For facts, numbers, and regulations, do not fabricate — state your uncertainty if unsure.';
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
        executedModelId: validatedModelId,
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
          executedModelId: validatedModelId,
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

  // 2b. URL Interceptor — detect Google Workspace URLs, fetch document content
  // Must run BEFORE PII masking so doc text is masked atomically with prompt.
  let extractedDocumentText: string | undefined;
  let documentTitle: string | undefined;
  let fileId: string | undefined;
  let fileMimeType: string | undefined;
  let effectivePrompt = prompt;

  const driveFetchStartTime = Date.now();

  try {
    const urlResult = await interceptUrls(prompt, user.sub);
    if (urlResult) {
      effectivePrompt = urlResult.cleanedPrompt;
      extractedDocumentText = urlResult.extractedDocumentText;
      documentTitle = urlResult.documentTitle;
      fileId = urlResult.fileId;
      fileMimeType = urlResult.mimeType;
    }
  } catch (err: unknown) {
    if (err instanceof GoogleDriveNotAuthorizedError) {
      res.status(401).json({
        error: 'GOOGLE_DRIVE_NOT_AUTHORIZED',
        message: 'Google Drive access required. Please authorize.',
      });
      return;
    }
    if (err instanceof GoogleDriveTokenRevokedError) {
      res.status(401).json({
        error: 'GOOGLE_DRIVE_TOKEN_REVOKED',
        message: 'Sesi Google berakhir, silakan izinkan ulang.',
      });
      return;
    }
    // Drive API errors during fetch — emit as SSE error later, but for now
    // the fetch happens before SSE setup, so return JSON error
    const driveErr = err as Error & { code?: string; statusCode?: number };
    res.status(driveErr.statusCode ?? 500).json({
      error: driveErr.code ?? 'GOOGLE_DRIVE_FETCH_ERROR',
      message: driveErr.message || 'Gagal mengambil dokumen dari Google Drive',
    });
    return;
  }

  // 3. Mask the prompt (and document text if present) with PII masker (fail-closed)
  let maskedPrompt: string;
  let maskedDocumentText: string | undefined;
  let piiDetected = false;          // Sovereignty gate: restricted data present
  try {
    // Mask prompt and document text separately (NOT combined-then-split — masker changes string length)
    const promptMask = mask(effectivePrompt);
    maskedPrompt = promptMask.maskedText;
    piiDetected = promptMask.entityCount > 0;

    if (extractedDocumentText) {
      const docMask = mask(extractedDocumentText);
      maskedDocumentText = docMask.maskedText;
      if (docMask.entityCount > 0) piiDetected = true;
    }
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
  // Sticky internal document context carried by the session (set on an earlier WGS fetch).
  let sessionInternalDocumentContext: string | undefined;
  let sessionInternalDocumentTitle: string | undefined;
  try {
    const session = await getValidatedSession(user.sub, req.body.sessionId);
    sessionId = session.id;
    sessionInternalDocumentContext = session.internalDocumentContext;
    sessionInternalDocumentTitle = session.internalDocumentTitle;
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
    // 6b. Sticky internal document context. A Google Workspace document fetched this turn
    // becomes session state, so later turns (which carry no URL) stay internal — never a
    // Tier-3 candidate — and still receive the document content.
    if (maskedDocumentText) {
      await setInternalDocumentContext(sessionId, maskedDocumentText.slice(0, 50000), documentTitle);
    }
    // Prefer this turn's fetch; else fall back to the document stored by an earlier turn.
    const effectiveDocumentText = maskedDocumentText ?? sessionInternalDocumentContext;
    const documentTextFromSession = !maskedDocumentText && !!sessionInternalDocumentContext;

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
        modalityFlags: { textOnly: !effectiveDocumentText, documentText: !!effectiveDocumentText, image: false, mixed: false },
        manualOverrideApplied: false,
        passthrough: true,
        flags: ['passthrough'],
        skill: 'fallback',
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
        piiDetected,
        conversationContext,
        maskedDocumentText: effectiveDocumentText,
        documentTextFromSession,
      };

      try {
        console.log(`[inference] Starting auto routing for prompt (${maskedPrompt.length} chars)...`);
        const routingStart = Date.now();
        routingDecision = await routeRequest(routingInput);
        const routingDuration = Date.now() - routingStart;
        executedModelId = routingDecision.executedModelId;
        effectivePrompt = routingDecision.refinedPrompt;
        console.log(`[inference] Routing complete in ${routingDuration}ms → model=${executedModelId}, reason=${routingDecision.routingReasonCode}, flags=[${routingDecision.flags.join(',')}]`);
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
          modalityFlags: { textOnly: !effectiveDocumentText, documentText: !!effectiveDocumentText, image: false, mixed: false },
          manualOverrideApplied: false,
          flags: ['routing-fallback'],
          skill: 'fallback',
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
        modalityFlags: { textOnly: !effectiveDocumentText, documentText: !!effectiveDocumentText, image: false, mixed: false },
        manualOverrideApplied: true,
        flags: [],
        skill: 'fallback',
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

    // 10c. Routing metadata SSE — emitted from the current (possibly post-finalize) decision.
    // A Tier-3 candidate defers emission until after knowledge retrieval resolves the final tier,
    // so the client/audit see the real execution model (external vs private Bedrock).
    const isTier3Candidate = routingDecision?.flags?.includes('tier3-candidate') === true;
    const writeRoutingEvent = (): void => {
      if (!config.routing.metadataEnabled || !routingDecision) return;
      const routingMetadata: RoutingMetadataEvent = {
        routingState: routingDecision.routingState,
        executedModelId: routingDecision.executedModelId,
        routingReasonCode: routingDecision.routingReasonCode,
        modalityFlags: routingDecision.modalityFlags,
        manualOverrideApplied: routingDecision.manualOverrideApplied,
        flags: routingDecision.flags,

        // Routing decision timing (ms)
        routingDurationMs: routingDecision.routingDurationMs,

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
      };
      res.write(`event: routing\ndata: ${JSON.stringify(routingMetadata)}\n\n`);
    };
    if (!isTier3Candidate) writeRoutingEvent();

    // 11b. Build inference request using contextOutput.inference_payload
    const inferenceMessages: BedrockMessage[] = contextOutput.inference_payload.slice(0, -1);
    const currentUserMessage: BedrockMessage = {
      role: 'user',
      content: [{ text: effectivePrompt }],
    };
    const conversationMessages: BedrockMessage[] = [...inferenceMessages, currentUserMessage];

    // Knowledge retrieval (Tier 2) — semantic search gated at KNOWLEDGE_MIN_SCORE, with
    // self-timeout; degrades to [] on failure. Empty result on a candidate → Tier-3 below.
    const knowledgeChunks = await knowledgeSearch(effectivePrompt, config.knowledge.topK);

    // Tier-3 finalize: the sovereignty gate's knowledge half lives here, AFTER retrieval.
    // A candidate escalates to the external model only when retrieval found nothing — internal
    // knowledge text must never leave for an external provider. Restricted candidates are
    // unreachable (classifier returned auto-tier-1 in routing). Emit the deferred routing event
    // with the final tier before any delta stream starts.
    if (routingDecision?.flags?.includes('tier3-candidate')) {
      const tier3Model = await getDefaultTier3Model();
      if (knowledgeChunks.length === 0 && tier3Model) {
        executedModelId = tier3Model;
        routingDecision = {
          ...routingDecision,
          executedModelId: tier3Model,
          routingReasonCode: 'auto-tier-3',
          flags: ['sovereign-tier-3'],
        };
        console.log(`[inference] Tier-3 escalation → external model=${tier3Model} (no internal knowledge)`);
      } else {
        routingDecision = {
          ...routingDecision,
          flags: routingDecision.flags.filter((f) => f !== 'tier3-candidate'),
        };
        console.log('[inference] Tier-3 candidate downgraded to private Bedrock (internal knowledge grounds answer)');
      }
      writeRoutingEvent();
    }

    // Tier-1 internal tool-loop gate (default OFF — zero behavior change when disabled).
    // Runs only on the private-Bedrock JSON-text path with an allowlisted model; never on
    // sovereign-tier-3 escalation or the multipart/image path (separate handler).
    const tier1ToolsOn =
      !routingDecision?.flags?.includes('sovereign-tier-3') &&
      config.routing.tier1Tools.enabled &&
      executedModelId === (config.routing.tier1Tools.modelId || config.routing.autoModelId);

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
        const role = isPassthrough ? passthroughRole : getRoleForSkill('fallback');
        const lang = 'indonesian';

        // Start with a clear instruction or role identity, then language
        let s = 'You are ' + role + '. Respond in ' + lang + '.';

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
        s += '\n\n' + FORMAT_INSTRUCTION;

        // Knowledge Layer: inject retrieved reference documents + citation rule.
        const knowledgeSection = buildKnowledgeSection(knowledgeChunks);
        if (knowledgeSection) s += '\n\n' + knowledgeSection;

        // Google Workspace document: inject fetched document content as context.
        if (effectiveDocumentText) {
          const docLabel = documentTitle || sessionInternalDocumentTitle || 'Dokumen';
          s += '\n\n[Dokumen Google Drive: ' + docLabel + ']\n' + effectiveDocumentText.slice(0, 50000);
        }

        // Grounding: prevent hallucination by anchoring to provided context — clause chosen
        // per execution path (Tier-1 tool / sovereign-tier-3 external / internal doc).
        s += '\n\n' + buildGroundingClause({
          tier1ToolsOn,
          sovereignTier3: routingDecision?.flags?.includes('sovereign-tier-3') === true,
        });

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

    try {
      console.log(`[inference] Calling ${routingDecision?.flags?.includes('sovereign-tier-3') ? 'external' : 'generate()'} with model=${resolveModelForInvocation(executedModelId)}, prompt length=${effectivePrompt.length}, history messages=${contextOutput.historyMessageCount}`);

      // ── Execution Branch ─────────────────────────────────────────
      // Sequential reasoning removed (Tahap 1, Req 1.2) — single-shot only.
      // Tier-3 decision → OpenAI-compatible external stream (delta/metadata/done parity).
      // Else → Bedrock generate(); generate() emits the `done` event internally.
      const isTier3External = routingDecision?.flags?.includes('sovereign-tier-3') === true;
      const tier3ModelId = resolveModelForInvocation(executedModelId);
      const t3Capable = config.routing.externalTier3.toolModelPrefixes.some(
        (p) => p && tier3ModelId.startsWith(p),
      );
      const tier3Tools = isTier3External && t3Capable ? AVAILABLE_TOOLS : undefined;
      const tier3Thinking = isTier3External && t3Capable ? config.routing.externalTier3.thinkingParams : undefined;
      const result = isTier3External
        ? await streamExternalCompletion(
            conversationRequest,
            config.routing.externalTier3.baseUrl,
            config.routing.externalTier3.apiKey,
            res,
            tier3Tools,
            tier3Thinking,
          )
        : tier1ToolsOn
          ? await generate(conversationRequest, res, {
              tools: TIER1_TOOLS,
              execTool: execTier1Tool,
              maxIterations: config.routing.tier1Tools.maxIterations,
            }) as ConversationInferenceResult
          : await generate(conversationRequest, res) as ConversationInferenceResult;

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
        routingReasonCode: routingDecision?.routingReasonCode,
        executedModelId: routingDecision?.executedModelId,
        manualOverrideApplied: routingDecision?.manualOverrideApplied,
        routingFlags: routingDecision?.flags,
        sessionId,
        replayedMessageCount: contextOutput.historyMessageCount,
        contextTruncated: contextOutput.truncated,
        contextSummarized: false,
        sessionContext: routingDecision?.sessionContext,
        knowledgeSourceIds: knowledgeChunks.map((c) => c.id),
        embeddingInputTokens,
        toolCallsMeta: result.toolCallsMeta,
        orchestrationMeta: fileId ? {
          action: 'gdrive_fetch',
          fileId,
          fileName: documentTitle,
          mimeType: fileMimeType,
          durationMs: Date.now() - driveFetchStartTime,
          success: true,
        } : undefined,
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
        routingReasonCode: routingDecision?.routingReasonCode,
        executedModelId: routingDecision?.executedModelId,
        manualOverrideApplied: routingDecision?.manualOverrideApplied,
        routingFlags: routingDecision?.flags,
        sessionId,
        replayedMessageCount: contextOutput.historyMessageCount,
        contextTruncated: contextOutput.truncated,
        contextSummarized: false,
        sessionContext: routingDecision?.sessionContext,
        orchestrationMeta: fileId ? {
          action: 'gdrive_fetch',
          fileId,
          fileName: documentTitle,
          mimeType: fileMimeType,
          durationMs: Date.now() - driveFetchStartTime,
          success: true,
        } : undefined,
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
  let piiDetected = false;          // Sovereignty gate: PII in prompt OR any document text
  try {
    const maskResult = mask(effectivePrompt);
    maskedPrompt = maskResult.maskedText;
    piiDetected = maskResult.entityCount > 0;
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
        if (maskResult.entityCount > 0) piiDetected = true;
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
      piiDetected,
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
      routingState: routingDecision.routingState,
      executedModelId: finalExecutedModelId,
      routingReasonCode: needsOCR ? 'ocr-two-stage' : routingDecision.routingReasonCode,
      modalityFlags: routingDecision.modalityFlags,
      manualOverrideApplied: routingDecision.manualOverrideApplied,
      flags: routingDecision.flags,

      // Routing decision timing (ms)
      routingDurationMs: routingDecision.routingDurationMs,

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
    };
    res.write(`event: routing\ndata: ${JSON.stringify(routingMetadata)}\n\n`);
  }

  // Step 15: Call generate (streams enhance model or original model)
  // If OCR switched to enhance model, fall back to original routing model on failure
  let result: ConversationInferenceResult | undefined;
  const targetModel = resolveModelForInvocation(finalExecutedModelId);
  const fallbackModel = executedModelId !== finalExecutedModelId ? resolveModelForInvocation(executedModelId) : null;

  try {  // middle try — wraps generate, verifier, storage, audit; catch is main error handler below

  // Sequential reasoning removed (Tahap 1, Req 1.2) — single-shot generate() below.
  if (!result) {
    try {
      const conversationRequest: ConversationInferenceRequest = {
        messages: conversationMessages,
        modelId: targetModel,
        userId: user.sub,
        system: (() => {
        const role = getRoleForSkill('fallback');
        const lang = 'indonesian';
        let s = 'You are ' + role + '. Respond in ' + lang + '.';

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
        s += '\n\n' + FORMAT_INSTRUCTION;
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
      routingReasonCode: needsOCR ? 'ocr-two-stage' : routingDecision?.routingReasonCode,
      executedModelId: routingDecision?.executedModelId,
      manualOverrideApplied: routingDecision?.manualOverrideApplied,
      routingFlags: routingDecision?.flags,
      // Session metadata
      sessionId,
      replayedMessageCount: contextOutput.historyMessageCount,
      contextTruncated: contextOutput.truncated,
      contextSummarized: false,
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
      routingReasonCode: needsOCR ? 'ocr-two-stage' : routingDecision?.routingReasonCode,
      executedModelId: routingDecision?.executedModelId,
      manualOverrideApplied: routingDecision?.manualOverrideApplied,
      routingFlags: routingDecision?.flags,
      // Session metadata
      sessionId,
      replayedMessageCount: contextOutput.historyMessageCount,
      contextTruncated: contextOutput.truncated,
      contextSummarized: false,
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
