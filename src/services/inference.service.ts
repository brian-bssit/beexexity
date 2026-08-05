import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import type { Response } from 'express';
import { config } from '../config/index.js';
import {
  ALLOWED_MODELS,
  DEFAULT_MODEL,
  type InferenceRequest,
  type InferenceResult,
} from '../types/inference.types.js';
import type {
  ConversationInferenceRequest,
  ConversationInferenceResult,
} from '../types/session.types.js';
import { getModelMaxOutputTokens } from '../config/model-capabilities.js';
import { query } from '../config/database.js';

/**
 * Inference service — model validation, Bedrock API invocation, and SSE streaming.
 * @see Requirements 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

/** Base delay for exponential backoff in milliseconds */
const BASE_DELAY_MS = 1000;

/** Maximum number of retry attempts for throttling errors */
const MAX_RETRIES = 3;

/**
 * Custom error class for sanitized inference errors.
 * Used to provide user-friendly error messages without exposing AWS internals.
 */
export class InferenceError extends Error {
  public readonly category: 'throttling' | 'timeout' | 'model_error';
  public readonly statusCode: number;

  constructor(message: string, category: 'throttling' | 'timeout' | 'model_error', statusCode: number) {
    super(message);
    this.name = 'InferenceError';
    this.category = category;
    this.statusCode = statusCode;
  }
}

/**
 * Determines whether an error is a throttling error that should trigger a retry.
 * Checks for ThrottlingException name or HTTP 429 status code.
 */
export function isThrottlingError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;

  const err = error as Record<string, unknown>;

  // AWS SDK v3 ThrottlingException
  if (err.name === 'ThrottlingException') return true;

  // Check $metadata.httpStatusCode === 429
  if (
    err.$metadata &&
    typeof err.$metadata === 'object' &&
    (err.$metadata as Record<string, unknown>).httpStatusCode === 429
  ) {
    return true;
  }

  return false;
}

/**
 * Determines whether an error is a timeout error that should NOT be retried.
 */
export function isTimeoutError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;

  const err = error as Record<string, unknown>;

  // Check for TimeoutError name
  if (err.name === 'TimeoutError') return true;

  // Check for timeout indication in message
  if (typeof err.message === 'string' && err.message.toLowerCase().includes('timeout')) return true;

  return false;
}

/**
 * Sanitizes an error from Bedrock, stripping out AWS ARNs, request IDs, and stack traces.
 * Returns a user-friendly InferenceError.
 */
export function sanitizeError(error: unknown, category: 'throttling' | 'timeout' | 'model_error'): InferenceError {
  const statusMap = {
    throttling: 503,
    timeout: 504,
    model_error: 502,
  };

  const messageMap = {
    throttling: 'Service temporarily busy. Please try again later.',
    timeout: 'Model response timed out. Please try again.',
    model_error: 'Model processing error. Please try a different model or try again later.',
  };

  return new InferenceError(messageMap[category], category, statusMap[category]);
}

/**
 * Wraps an async operation with retry logic for throttling errors.
 *
 * - Retries ONLY on ThrottlingException (HTTP 429)
 * - Exponential backoff: delay = 1000ms × 2^attempt (1s, 2s, 4s)
 * - Maximum 3 retry attempts
 * - Throws immediately on timeout or model errors (no retry)
 * - After exhausted retries, throws a sanitized error (no AWS internals)
 *
 * @param fn - The async function to execute with retry protection
 * @param delayFn - Optional delay function for testing (defaults to setTimeout-based promise)
 * @returns The result of the async function if successful
 * @throws InferenceError with sanitized message on failure
 *
 * @see Requirements 6.4, 6.5, 6.6
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  delayFn: (ms: number) => Promise<void> = defaultDelay,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Timeout errors: throw immediately, no retry
      if (isTimeoutError(error)) {
        throw sanitizeError(error, 'timeout');
      }

      // Non-throttling errors (model errors): throw immediately, no retry
      if (!isThrottlingError(error)) {
        throw sanitizeError(error, 'model_error');
      }

      // Throttling error: retry if we haven't exhausted attempts
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await delayFn(delay);
      }
    }
  }

  // All retries exhausted — throw sanitized throttling error
  throw sanitizeError(lastError, 'throttling');
}

/**
 * Default delay function using setTimeout.
 */
function defaultDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** BedrockRuntimeClient configured for ap-southeast-3 (Jakarta). */
const bedrockClient = new BedrockRuntimeClient({
  region: config.aws.region,
});

/**
 * Validate a model ID against the allowed models list.
 * Returns the validated model ID if it is in the allowed list,
 * or the default model if no modelId is provided.
 * Throws a validation error with 400 status if the modelId is not allowed.
 *
 * @param modelId - Optional model identifier to validate
 * @returns The validated model ID string
 * @throws Error with statusCode 400 if modelId is not in ALLOWED_MODELS
 */
export async function validateModelId(modelId?: string, userId?: string): Promise<string> {
  // Default to qwen.qwen3-32b-v1:0 when modelId is not specified
  if (modelId === undefined || modelId === null || modelId === '') {
    return DEFAULT_MODEL;
  }

  // Check if the provided modelId is in the allowed list
  if (!ALLOWED_MODELS.includes(modelId as typeof ALLOWED_MODELS[number])) {
    const error = new Error(
      `Invalid model. Choose from: ${ALLOWED_MODELS.join(', ')}`,
    );
    (error as Error & { code: string }).code = 'INVALID_MODEL';
    (error as Error & { statusCode: number }).statusCode = 400;
    throw error;
  }

  // Private model access check
  if (userId) {
    const hasAccess = await checkModelAccess(userId, modelId);
    if (!hasAccess) {
      const error = new Error('You do not have access to this model');
      (error as Error & { code: string }).code = 'ACCESS_DENIED';
      (error as Error & { statusCode: number }).statusCode = 403;
      throw error;
    }
  }

  return modelId;
}

/**
 * Check if a user has access to a model.
 * If the model has no access rows at all, it's public — everyone can use it.
 * If the model has access rows, the user must be in the whitelist.
 */
async function checkModelAccess(userId: string, modelId: string): Promise<boolean> {
  try {
    // Check if model has any access rows (= private model)
    const { rows } = await query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM user_model_access WHERE model_id = $1) AS exists',
      [modelId],
    );
    if (!rows[0]?.exists) return true; // public model — no access restrictions

    // Model is private — check if this user is whitelisted
    const { rows: access } = await query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM user_model_access WHERE user_id = $1 AND model_id = $2) AS exists',
      [userId, modelId],
    );
    return access[0]?.exists ?? false;
  } catch {
    // DB error — fail closed: reject access to private models
    return false;
  }
}

/**
 * Type guard to detect a ConversationInferenceRequest (has messages array).
 */
function isConversationRequest(
  request: InferenceRequest | ConversationInferenceRequest,
): request is ConversationInferenceRequest {
  return 'messages' in request && Array.isArray((request as ConversationInferenceRequest).messages);
}

/**
 * Send an inference request to AWS Bedrock via ConverseStream and
 * stream the response back to the client as Server-Sent Events.
 *
 * Supports two request shapes:
 * - InferenceRequest (single prompt, backward compatible)
 * - ConversationInferenceRequest (full messages array for multi-turn)
 *
 * SSE event mapping:
 * - contentBlockDelta → event: delta
 * - metadata → event: metadata (with token usage)
 * - messageStop → event: done
 *
 * @param request - The inference request (single prompt or conversation messages)
 * @param res - Express Response object to write SSE events to
 * @returns InferenceResult or ConversationInferenceResult with assistantText
 *
 * @see Requirements 3.1, 2.7
 */
export async function generate(
  request: InferenceRequest | ConversationInferenceRequest,
  res: Response,
): Promise<InferenceResult | ConversationInferenceResult> {
  let messages: Message[];

  if (isConversationRequest(request)) {
    // Multi-turn conversation: use full messages array directly
    messages = request.messages.map(msg => ({
      role: msg.role as Message['role'],
      content: msg.content,
    }));
  } else {
    // Single-prompt (backward compatible): build single user message
    let content: any[];
    if (request.contentBlocks && request.contentBlocks.length > 0) {
      // Multimodal: use content blocks directly
      content = request.contentBlocks.map(block => {
        if ('text' in block) {
          return { text: block.text };
        }
        if ('image' in block) {
          return { image: block.image };
        }
        // Document block
        return { document: (block as any).document };
      });
    } else {
      // Legacy text-only: wrap maskedPrompt
      content = [{ text: request.maskedPrompt }];
    }
    messages = [{ role: 'user' as Message['role'], content }];
  }

  // Use per-model max output token limit, or frontend override if provided.
  const inferenceConfig = {
    maxTokens: request.inferenceConfig?.maxTokens ?? getModelMaxOutputTokens(request.modelId),
    ...(request.inferenceConfig?.temperature !== undefined && { temperature: request.inferenceConfig.temperature }),
    ...(request.inferenceConfig?.topP !== undefined && { topP: request.inferenceConfig.topP }),
  };

  const command = new ConverseStreamCommand({
    modelId: request.modelId,
    messages,
    ...(isConversationRequest(request) && request.system
      ? { system: [{ text: request.system }] }
      : {}),
    inferenceConfig,
  });

  // Dynamic timeout: larger inputs need more time before first token.
  // Estimate input token count (~4 chars/token) and allow ~2ms per token,
  // with a 30s floor for tiny prompts and 180s ceiling for huge ones.
  const inputCharCount = messages.reduce((sum, msg) => {
    const texts = (msg.content || []).filter((c: any) => c.text).map((c: any) => c.text);
    return sum + texts.join('').length;
  }, 0);
  const estimatedInputTokens = Math.ceil(inputCharCount / 4);
  const connectionTimeoutMs = Math.min(Math.max(estimatedInputTokens * 2, 30_000), 180_000);

  const controller = new AbortController();
  const inferenceTimeout = setTimeout(() => {
    controller.abort();
  }, connectionTimeoutMs);

  let response;
  try {
    response = await bedrockClient.send(command, { abortSignal: controller.signal });
  } catch (err: unknown) {
    clearTimeout(inferenceTimeout);
    console.error(`[inference] Bedrock ConverseStream failed for model ${request.modelId}:`, (err as Error).message);
    throw err;
  }

  // Connection established, stream started — clear the timeout so it doesn't
  // abort mid-stream on longer responses.
  clearTimeout(inferenceTimeout);

  let inputTokens = 0;
  let outputTokens = 0;
  let assistantText = '';

  if (response.stream) {
    for await (const event of response.stream) {
      if (event.contentBlockDelta) {
        const text = event.contentBlockDelta.delta?.text ?? '';
        assistantText += text;
        res.write(`event: delta\ndata: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
      } else if (event.metadata) {
        inputTokens = event.metadata.usage?.inputTokens ?? 0;
        outputTokens = event.metadata.usage?.outputTokens ?? 0;
        res.write(`event: metadata\ndata: ${JSON.stringify({ inputTokens, outputTokens })}\n\n`);
      } else if (event.messageStop) {
        res.write(`event: done\ndata: {}\n\n`);
      }
    }
  }

  // Return ConversationInferenceResult when conversation mode, otherwise legacy InferenceResult
  if (isConversationRequest(request)) {
    return {
      status: 'success',
      inputTokens,
      outputTokens,
      modelId: request.modelId,
      assistantText,
    } as ConversationInferenceResult;
  }

  return {
    status: 'success',
    inputTokens,
    outputTokens,
    modelId: request.modelId,
  };
}

/**
 * Non-streaming inference for OCR/extraction tasks.
 * Sends a request to Bedrock Converse and returns the full text response.
 * Used by the two-stage pipeline: Nova extracts image/document content,
 * then Qwen3-235b enhances the extracted text for the final response.
 */
export async function generateNonStreaming(
  modelId: string,
  messages: Message[],
  maxTokens: number = 4096,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const command = new ConverseCommand({
      modelId,
      messages,
      inferenceConfig: { maxTokens, temperature: 0.1 },
    });

    const response = await bedrockClient.send(command, {
      abortSignal: controller.signal,
    });

    return response.output?.message?.content?.[0]?.text ?? '';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Repair a response that failed verification.
 * Calls Bedrock Converse with a repair system prompt targeting specific violations.
 * Non-streaming — returns the repaired full text, or null on failure.
 *
 * @param modelId     The model that generated the original response.
 * @param messages    The original conversation messages array.
 * @param violations  Verification violations to fix.
 * @param maxTokens   Max tokens for the repair response.
 */
export async function repairResponse(
  modelId: string,
  messages: Message[],
  violations: Array<{ field: string; issue: string; severity: 'error' | 'warn' }>,
  maxTokens: number = 4096,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const violationDetails = violations
      .filter(v => v.severity === 'error')
      .map(v => `- [${v.field}] ${v.issue}`)
      .join('\n');

    const systemPrompt = [
      'The previous response had the following issues that MUST be fixed:',
      '',
      violationDetails,
      '',
      'Revise your response to fix ONLY these specific issues. Keep the original intent, facts, and tone.',
      'If a required section is missing, add it. If prohibited content exists, remove or replace it.',
      'Return ONLY the fixed response. No meta-commentary, no explanations, no markdown.',
      'Preserve ALL other content exactly as-is.',
    ].join('\n');

    const command = new ConverseCommand({
      modelId,
      system: [{ text: systemPrompt }],
      messages,
      inferenceConfig: { maxTokens, temperature: 0.1 },
    });

    const response = await bedrockClient.send(command, {
      abortSignal: controller.signal,
    });

    const text = response.output?.message?.content?.[0]?.text?.trim();
    return text && text.length > 0 ? text : null;
  } catch (error) {
    console.error('[repair] Repair generation failed:', (error as Error).message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Semantic Verification ─────────────────────────────────────────────────────────

/**
 * Lightweight LLM-as-a-judge — checks whether the assistant response is
 * semantically correct and complete for the original prompt.
 *
 * Runs for ALL skills. Uses qwen3-32b with a strict judge prompt, maxTokens=256,
 * temperature=0 for deterministic verdicts.
 *
 * @returns { is_correct, missing_elements } or null on failure (graceful degradation).
 */
export async function semanticJudge(
  originalPrompt: string,
  assistantText: string,
  _skill: string,
): Promise<{ is_correct: boolean; missing_elements: string[] } | null> {

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const judgePrompt = [
      'You are a strict judge evaluating an AI response. Your task: determine if the response accurately and completely answers the user\'s original request.',
      '',
      'Rules:',
      '- Mark is_correct=true ONLY if the response correctly addresses the core request without hallucination.',
      '- If the response misses important elements, list them in missing_elements.',
      '- Be strict about factual accuracy for numbers, regulations, and code.',
      '- Be lenient about phrasing and style — only flag substantive omissions.',
      '',
      'Original request:',
      originalPrompt,
      '',
      'AI response:',
      assistantText,
      '',
      'Output ONLY valid JSON: { "is_correct": boolean, "missing_elements": string[] }',
    ].join('\n');

    const command = new ConverseCommand({
      modelId: 'qwen.qwen3-32b-v1:0',
      system: [{ text: 'You are a factual accuracy judge. Reply with JSON only.' }],
      messages: [{ role: 'user', content: [{ text: judgePrompt }] }],
      inferenceConfig: { maxTokens: 256, temperature: 0 },
    });

    const response = await bedrockClient.send(command, { abortSignal: controller.signal });
    const raw = response.output?.message?.content?.[0]?.text?.trim();
    if (!raw) return null;

    const jsonStr = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    const parsed = JSON.parse(jsonStr);

    return {
      is_correct: parsed.is_correct === true,
      missing_elements: Array.isArray(parsed.missing_elements) ? parsed.missing_elements : [],
    };
  } catch (error) {
    console.error('[semantic-judge] Judge call failed:', (error as Error).message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Invoke Nova Lite via raw InvokeModel API with Messages schema.
 * Nova Lite does not support the Converse API — it requires the raw
 * InvokeModel endpoint with schemaVersion: "messages-v1".
 *
 * Used by the two-stage OCR pipeline for image/document extraction.
 * All processing stays in ap-southeast-3 (no cross-region inference profile).
 */
export async function invokeNovaForOCR(
  messages: Array<{ role: string; content: any[] }>,
  maxTokens: number = 4096,
): Promise<string> {
  const body = JSON.stringify({
    schemaVersion: 'messages-v1',
    messages,
    inferenceConfig: { maxTokens, temperature: 0.1 },
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const command = new InvokeModelCommand({
      modelId: 'amazon.nova-lite-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });

    const response = await bedrockClient.send(command, {
      abortSignal: controller.signal,
    });

    const bodyStr = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(bodyStr);
    return parsed.output?.message?.content?.[0]?.text ?? '';
  } finally {
    clearTimeout(timeout);
  }
}

/** Exposed for testing — allows injecting a mock client. */
export function _getBedrockClient(): BedrockRuntimeClient {
  return bedrockClient;
}

/** Overwrite the module-level client (for unit testing with mocks). */
export function _setBedrockClient(client: BedrockRuntimeClient): void {
  Object.assign(bedrockClient, client);
}

// Re-export a factory for testable client injection
export { bedrockClient };
