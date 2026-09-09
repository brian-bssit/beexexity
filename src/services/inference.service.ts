import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  type ContentBlock,
  type Message,
  type Tool,
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
import { mask } from './pii-masker.service.js';
import type { ToolCallAuditMeta } from '../types/audit.types.js';

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
 * Exported for the routing seam (selectAutoModel) — auto must degrade silently
 * on access denial, whereas validateModelId throws 403 for manual.
 */
export async function checkModelAccess(userId: string, modelId: string): Promise<boolean> {
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

/** One native Bedrock `toolConfig.tools[]` entry (SDK type). */
export type BedrockToolSpec = Tool;

/**
 * Optional tool-loop mode for generate(). When provided, generate() runs a bounded
 * ReAct loop over Bedrock ConverseStream instead of the single-shot path. Absent →
 * today's byte-identical single-shot stream. @see docs/features/tier1-tools/
 */
export interface Tier1ToolLoopOptions {
  tools: Tool[];
  /** Executes a tool locally. Must never throw raw errors upward (returns safe text). */
  execTool: (name: string, args: unknown) => Promise<string>;
  /** Max tool-capable rounds; a final plain round follows (cap) — external-chat mirror. */
  maxIterations: number;
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
 * @param toolLoop - Optional bounded ReAct loop (tier1-tools). When absent this
 *   function is byte-identical to the pre-feature single-shot stream.
 * @returns InferenceResult or ConversationInferenceResult with assistantText
 *
 * @see Requirements 3.1, 2.7
 */
export async function generate(
  request: InferenceRequest | ConversationInferenceRequest,
  res: Response,
  toolLoop?: Tier1ToolLoopOptions,
): Promise<InferenceResult | ConversationInferenceResult> {
  if (toolLoop) return runToolLoop(request, res, toolLoop);
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

/** ContentBlock emitted by one assistant round, in stream order (text can precede toolUse). */
interface RoundBlock {
  kind: 'text' | 'tool';
  text?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: string;
}

/** Bedrock requires toolUse.input to be a JSON object — coerce, never a bare string. */
function toInputObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Bounded ReAct loop over Bedrock ConverseStream (tier1-tools). Live-streams text
 * deltas; intercepts toolUse by contentBlockIndex; runs ≤ maxIterations tool rounds,
 * then a final plain round. Emits ONE summed `metadata` + `done` at the end and
 * returns accumulated assistantText (matches exactly what the client saw).
 * @see docs/features/tier1-tools/design.md
 */
async function runToolLoop(
  request: InferenceRequest | ConversationInferenceRequest,
  res: Response,
  toolLoop: Tier1ToolLoopOptions,
): Promise<InferenceResult | ConversationInferenceResult> {
  const { tools, execTool, maxIterations } = toolLoop;

  // ── Build working history (mirrors the single-shot builder) ─────────
  let history: Message[];
  if (isConversationRequest(request)) {
    history = request.messages.map((msg) => ({
      role: msg.role as Message['role'],
      content: msg.content,
    }));
  } else {
    let content: any[];
    if (request.contentBlocks && request.contentBlocks.length > 0) {
      content = request.contentBlocks.map((block) => {
        if ('text' in block) return { text: (block as { text: string }).text };
        if ('image' in block) return { image: (block as { image: unknown }).image };
        return { document: (block as { document: unknown }).document };
      });
    } else {
      content = [{ text: request.maskedPrompt }];
    }
    history = [{ role: 'user' as Message['role'], content }];
  }

  const inferenceConfig = {
    maxTokens: request.inferenceConfig?.maxTokens ?? getModelMaxOutputTokens(request.modelId),
    ...(request.inferenceConfig?.temperature !== undefined && { temperature: request.inferenceConfig.temperature }),
    ...(request.inferenceConfig?.topP !== undefined && { topP: request.inferenceConfig.topP }),
  };
  const system = isConversationRequest(request) && request.system
    ? [{ text: request.system }]
    : undefined;

  // Dynamic first-token timeout, same rule as the single-shot path.
  const estimatedInputTokens = Math.ceil(
    history.reduce((sum, msg) => {
      const texts = (msg.content || []).filter((c) => c && typeof c === 'object' && 'text' in c).map((c) => (c as { text: string }).text);
      return sum + texts.join('').length;
    }, 0) / 4,
  );

  let inputTokens = 0;
  let outputTokens = 0;
  let assistantText = '';
  const toolCallsMeta: ToolCallAuditMeta[] = [];

  for (let round = 0; round <= maxIterations; round++) {
    const hasTools = round < maxIterations; // last round forces a plain answer
    const command = new ConverseStreamCommand({
      modelId: request.modelId,
      messages: history,
      ...(system ? { system } : {}),
      inferenceConfig,
      ...(hasTools ? { toolConfig: { tools } } : {}),
    });

    const controller = new AbortController();
    const connectionTimeoutMs = Math.min(Math.max(estimatedInputTokens * 2, 30_000), 180_000);
    const inferenceTimeout = setTimeout(() => controller.abort(), connectionTimeoutMs);

    let response;
    try {
      response = await bedrockClient.send(command, { abortSignal: controller.signal });
    } catch (err: unknown) {
      clearTimeout(inferenceTimeout);
      throw err;
    }
    clearTimeout(inferenceTimeout);

    // ── Stream one round, tracking blocks in order ────────────────────
    const blocks: RoundBlock[] = [];
    const textByIndex = new Map<number, number>(); // blockIndex → last text block slot
    const toolByIndex = new Map<number, number>(); // blockIndex → tool block slot
    const lastText = () => blocks[blocks.length - 1];

    for await (const event of response.stream ?? []) {
      if (event.contentBlockStart) {
        const idx = event.contentBlockStart.contentBlockIndex as number;
        const ts = event.contentBlockStart.start?.toolUse;
        if (ts) {
          toolByIndex.set(idx, blocks.length);
          blocks.push({ kind: 'tool', toolUseId: ts.toolUseId, toolName: ts.name, toolInput: '' });
        }
        // text blocks stream without contentBlockStart (Bedrock) — nothing to record.
      } else if (event.contentBlockDelta) {
        const idx = event.contentBlockDelta.contentBlockIndex as number;
        const d = event.contentBlockDelta.delta;
        if (d?.text) {
          // text block may not have a recorded start — coalesce into the last text block
          const slot = textByIndex.get(idx) ?? (lastText()?.kind === 'text' ? blocks.length - 1 : -1);
          if (slot === -1) {
            textByIndex.set(idx, blocks.length);
            blocks.push({ kind: 'text', text: d.text });
          } else {
            (blocks[slot] as { text: string }).text += d.text;
          }
          assistantText += d.text;
          res.write(`event: delta\ndata: ${JSON.stringify({ type: 'text', content: d.text })}\n\n`);
        } else if (d?.toolUse?.input) {
          const slot = toolByIndex.get(idx);
          if (slot !== undefined) (blocks[slot] as { toolInput: string }).toolInput += String(d.toolUse.input);
        }
      } else if (event.metadata) {
        inputTokens += event.metadata.usage?.inputTokens ?? 0;
        outputTokens += event.metadata.usage?.outputTokens ?? 0;
      } else if (event.messageStop) {
        // per-round stop captured implicitly by loop end; single final done emitted below
      }
    }

    const toolBlocks = blocks.filter((b) => b.kind === 'tool');
    if (toolBlocks.length === 0 || !hasTools) break; // plain round or cap → final

    // ── Tool round: report, execute, append, continue ─────────────────
    res.write(`event: tool_call\ndata: ${JSON.stringify({ tools: toolBlocks.map((b) => b.toolName) })}\n\n`);

    history.push({
      role: 'assistant',
      content: blocks.map((b) =>
        b.kind === 'text'
          ? { text: b.text ?? '' }
          : { toolUse: { toolUseId: b.toolUseId, name: b.toolName, input: toInputObject(b.toolInput ?? '') } },
      ) as ContentBlock[],
    });

    for (const b of toolBlocks) {
      const inputObj = toInputObject(b.toolInput ?? '');
      const t0 = Date.now();
      let result: string;
      try {
        result = await execTool(b.toolName ?? '', inputObj);
      } catch {
        result = 'Gagal menjalankan tool tersebut. Coba lagi atau jawab berdasarkan konteks yang ada.';
      }
      // Audit traceability — args masked at write time only; raw query/result never stored.
      let argsMasked = '{}';
      try { argsMasked = mask(JSON.stringify(inputObj)).maskedText; } catch { /* never crash audit prep */ }
      toolCallsMeta.push({
        tool: b.toolName ?? 'unknown',
        args_masked: argsMasked.slice(0, 500),
        duration_ms: Date.now() - t0,
        result_chunks: (result.match(/\[Sumber:/g) ?? []).length,
        result_size: result.length,
      });
      history.push({
        role: 'user',
        content: [{ toolResult: { toolUseId: b.toolUseId, content: [{ text: result }], status: 'success' } }] as ContentBlock[],
      });
    }
  }

  res.write(`event: metadata\ndata: ${JSON.stringify({ inputTokens, outputTokens })}\n\n`);
  res.write('event: done\ndata: {}\n\n');

  if (isConversationRequest(request)) {
    return {
      status: 'success',
      inputTokens,
      outputTokens,
      modelId: request.modelId,
      assistantText,
      toolCallsMeta,
    } as ConversationInferenceResult;
  }
  return { status: 'success', inputTokens, outputTokens, modelId: request.modelId } as InferenceResult;
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
