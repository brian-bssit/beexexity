/**
 * External-chat service — OpenAI-compatible streaming client for the Tier-3 gateway.
 * Auto-only, text-only. Streams deltas/metadata/done onto the SSE writer exactly like the
 * Bedrock path (generate), so the handler's post-stream store/audit code is unchanged.
 * Errors are sanitized — the API key and base URL never reach the client or audit.
 *
 * Thinking + tools: when `tools` is provided the payload carries them and reasoning_content
 * deltas are forwarded as `event: reasoning`; a bounded ReAct loop executes local safe tools.
 * Reasoning is echoed verbatim into in-memory history (defensive — the DeepSeek thinking-mode
 * round-trip contract) but is never returned/persisted/logged; only final text content is.
 * @see docs/features/sovereign-tier-router/
 * @see docs/features/tier3-tools/
 */

import { InferenceError } from './inference.service.js';
import { executeTool } from './tool-registry.service.js';
import type { ToolDefinition } from './tool-registry.service.js';
import type {
  ConversationInferenceRequest,
  ConversationInferenceResult,
} from '../types/session.types.js';

const CHARS_PER_TOKEN = 4;
const MAX_TOOL_ITERATIONS = 3;

interface SSEWriter {
  write(chunk: string): unknown;
}

interface OpenAIUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** OpenAI wire-format message — additive fields used only inside this service. */
interface OpenAIWireMsg {
  role: string;
  content: string;
  reasoning_content?: string;
  tool_calls?: OpenAIWireToolCall[];
  tool_call_id?: string;
}

interface OpenAIWireToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/** Partial tool-call delta from the stream; `index` drives position. */
interface DeltaToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      reasoning_content?: string;
      tool_calls?: DeltaToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Stream a completion from an OpenAI-compatible /chat/completions endpoint, optionally
 * through a bounded ReAct loop. Writes `event: delta` per token (and `event: reasoning`
 * when present), then a single summed `event: metadata` + `event: done`.
 *
 * @param request        - Reuses the Bedrock text assembly: system + history + current masked prompt.
 * @param writer         - SSE writer (the Express response object).
 * @param tools          - Optional tool definitions; when absent the request is byte-identical to the
 *                         pre-thinking/pre-tools path (no tools/thinking fields).
 * @param thinkingParams - Optional extra top-level body params (e.g. Qwen `enable_thinking`) for
 *                         allowlisted thinking-capable models; spread verbatim into every body.
 */
export async function streamExternalCompletion(
  request: ConversationInferenceRequest,
  baseUrl: string,
  apiKey: string,
  writer: SSEWriter,
  tools?: ToolDefinition[],
  thinkingParams?: Record<string, unknown>,
): Promise<ConversationInferenceResult> {
  // Plain baseline — also the exact pre-feature body when `tools` is undefined.
  const messages: Array<{ role: string; content: string }> = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  for (const m of request.messages) {
    messages.push({ role: m.role, content: m.content.map((b) => b.text).join('\n') });
  }

  const wire: OpenAIWireMsg[] = messages.map((m) => ({ ...m }));
  const includeTools = !!(tools && tools.length > 0);

  let assistantText = '';
  let totalInput = 0;
  let totalOutput = 0;
  let iterations = 0;
  let forcePlain = false;
  let sawReasoning = false;
  let lastFinishReason: string | null = null;

  while (iterations < MAX_TOOL_ITERATIONS + 1) {
    iterations++;
    const round = await streamOnce({
      request,
      baseUrl,
      apiKey,
      writer,
      messages: wire,
      includeTools: includeTools && !forcePlain && iterations <= MAX_TOOL_ITERATIONS,
      tools,
      thinkingParams,
    });

    if (round.reasoningContent) sawReasoning = true;
    if (round.finishReason) lastFinishReason = round.finishReason;
    if (round.inTokens !== undefined) totalInput += round.inTokens;
    if (round.outTokens !== undefined) totalOutput += round.outTokens;
    assistantText += round.content;

    const hasTools =
      round.finishReason === 'tool_calls' || round.toolCalls.length > 0;

    if (hasTools && !forcePlain && round.toolCalls.length > 0) {
      if (iterations >= MAX_TOOL_ITERATIONS) {
        // Cap reached — force one final answer without tools.
        forcePlain = true;
        continue;
      }
      writer.write(
        `event: tool_call\ndata: ${JSON.stringify({ tools: round.toolCalls.map((t) => t.function.name) })}\n\n`,
      );
      wire.push({
        role: 'assistant',
        content: round.content,
        reasoning_content: round.reasoningContent || '',
        tool_calls: round.toolCalls,
      });
      for (const tc of round.toolCalls) {
        let result: string;
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          result = await executeTool(tc.function.name, args);
        } catch (e) {
          throw new InferenceError(
            `Tier-3 tool ${tc.function.name} failed: ${(e as Error).message}`.slice(0, 200),
            'model_error',
            502,
          );
        }
        wire.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      continue;
    }
    break; // final round (no tools)
  }

  // B1 guard: model exhausted its budget reasoning (explicit stop, or reasoning tokens
  // streamed) with no answer produced. Bare empty streams without reasoning stay a no-op.
  if (!assistantText && (sawReasoning || lastFinishReason === 'stop')) {
    throw new InferenceError(
      'Tier-3 model exhausted its reasoning budget without producing an answer',
      'model_error',
      502,
    );
  }

  const inputTokens = totalInput > 0 ? totalInput : estimateTokens(request, messages);
  const outputTokens = totalOutput > 0 ? totalOutput : Math.ceil(assistantText.length / CHARS_PER_TOKEN);

  writer.write(
    `event: metadata\ndata: ${JSON.stringify({ inputTokens, outputTokens })}\n\n`,
  );
  writer.write('event: done\ndata: {}\n\n');

  return {
    status: 'success',
    modelId: request.modelId,
    inputTokens,
    outputTokens,
    assistantText,
  };
}

/** One /chat/completions request: streams deltas/reasoning, merges tool calls, returns round state. */
async function streamOnce(opts: {
  request: ConversationInferenceRequest;
  baseUrl: string;
  apiKey: string;
  writer: SSEWriter;
  messages: OpenAIWireMsg[];
  includeTools: boolean;
  tools?: ToolDefinition[];
  thinkingParams?: Record<string, unknown>;
}): Promise<{
  content: string;
  reasoningContent: string;
  toolCalls: OpenAIWireToolCall[];
  finishReason: string | null;
  inTokens?: number;
  outTokens?: number;
}> {
  const { request, baseUrl, apiKey, writer, messages, includeTools, tools, thinkingParams } = opts;

  const body: Record<string, unknown> = {
    model: request.modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (includeTools && tools) body.tools = tools;
  if (thinkingParams) Object.assign(body, thinkingParams);
  if (request.inferenceConfig?.maxTokens) body.max_tokens = request.inferenceConfig.maxTokens;

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new InferenceError('Tier-3 gateway unreachable', 'model_error', 502);
  }

  if (!response.ok) {
    // Surface a sanitized reason only — never the key, URL, or raw upstream detail.
    const text = await response.text().catch(() => '');
    let reason = '';
    try {
      const parsed = JSON.parse(text);
      reason = String(parsed?.error?.message ?? '').slice(0, 200);
    } catch { /* keep reason empty */ }
    throw new InferenceError(
      `Tier-3 model ${request.modelId} failed (${response.status})${reason ? `: ${reason}` : ''}`,
      'model_error',
      response.status,
    );
  }

  if (!response.body) {
    throw new InferenceError('Tier-3 gateway returned no stream', 'model_error', 502);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningContent = '';
  const toolCalls: OpenAIWireToolCall[] = [];
  let usage: OpenAIUsage = {};
  let finishReason: string | null = null;
  let streamEnded = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { streamEnded = true; break; }

        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data);
        } catch { continue; } // ignore keep-alive / partial fragments

        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }
        const delta = choice?.delta;
        if (!delta) continue;

        if (delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
          writer.write(`event: reasoning\ndata: ${JSON.stringify({ content: delta.reasoning_content })}\n\n`);
        }
        if (delta.tool_calls?.length) {
          mergeToolCalls(toolCalls, delta.tool_calls);
        }
        const text = extractDeltaText(delta.content);
        if (text) {
          content += text;
          writer.write(`event: delta\ndata: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
        }
      }
      if (streamEnded) break;
    }
  } catch {
    throw new InferenceError('Tier-3 stream interrupted', 'model_error', 502);
  }

  return {
    content,
    reasoningContent,
    toolCalls,
    finishReason,
    inTokens: usage.inputTokens,
    outTokens: usage.outputTokens,
  };
}

/** Merge partial tool-call deltas (indexed) into a complete accumulated list. */
function mergeToolCalls(acc: OpenAIWireToolCall[], deltas: DeltaToolCall[]): void {
  for (const d of deltas) {
    const i = d.index ?? acc.length;
    if (!acc[i]) {
      acc[i] = { id: d.id ?? '', type: d.type ?? 'function', function: { name: d.function?.name ?? '', arguments: '' } };
    }
    if (d.id) acc[i].id = d.id;
    if (d.type) acc[i].type = d.type;
    if (d.function) {
      if (d.function.name) acc[i].function.name = d.function.name;
      if (d.function.arguments) acc[i].function.arguments += d.function.arguments;
    }
  }
}

/** OpenAI delta content is a string, or an array of {type:'text',text} parts on some gateways. */
function extractDeltaText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('');
  }
  return '';
}

/** chars/4 fallback for input tokens (matches the Bedrock-side convention). */
function estimateTokens(request: ConversationInferenceRequest, messages: Array<{ role: string; content: string }>): number {
  const base = request.system ? request.system.length : 0;
  const history = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil((base + history) / CHARS_PER_TOKEN);
}
