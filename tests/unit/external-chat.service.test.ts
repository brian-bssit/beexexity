/**
 * Tier-3 OpenAI-compatible streaming client tests. Global fetch is stubbed; no real I/O.
 * Covers SSE delta forwarding, usage capture, chars/4 fallback, and sanitized errors
 * (the API key and gateway URL must never appear in thrown messages).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamExternalCompletion } from '../../src/services/external-chat.service.js';
import { InferenceError } from '../../src/services/inference.service.js';
import type { ConversationInferenceRequest } from '../../src/types/session.types.js';

const enc = new TextEncoder();

/** Wrap raw SSE frames (each already '\n' terminated) in a 200 Response stream. */
function sseResponse(frames: string[]): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]));
      else controller.close();
    },
  });
  return new Response(stream, { status: 200, statusText: 'OK' });
}

function makeRequest(): ConversationInferenceRequest {
  return {
    sessionId: 's1',
    userId: 'u1',
    modelId: 'qwen3.7-flash-2026-07-15',
    system: 'Bantulah.',
    messages: [{ role: 'user', content: [{ text: 'Halo' }] }],
    inferenceConfig: {},
  } as unknown as ConversationInferenceRequest;
}

const frames = {
  delta1: 'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Halo "},"finish_reason":null}]}\n',
  deltaArray: 'data: {"id":"1","choices":[{"index":0,"delta":{"content":[{"type":"text","text":"dunia"}]},"finish_reason":null}]}\n',
  usage: 'data: {"id":"2","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n',
  done: 'data: [DONE]\n',
};

describe('streamExternalCompletion', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writes: string[];

  beforeEach(() => {
    writes = [];
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards deltas as SSE events and captures usage from the stream', async () => {
    fetchMock.mockResolvedValue(sseResponse([frames.delta1, frames.deltaArray, frames.usage, frames.done]));

    const result = await streamExternalCompletion(makeRequest(), 'https://gw.example.com/', 'secret-key', { write: (c) => writes.push(String(c)) });

    expect(result.status).toBe('success');
    expect(result.assistantText).toBe('Halo dunia');
    expect(result.inputTokens).toBe(7);
    expect(result.outputTokens).toBe(2);

    const deltaEvents = writes.filter((w) => w.startsWith('event: delta'));
    expect(deltaEvents).toHaveLength(2);
    expect(deltaEvents[0]).toContain('Halo ');
    expect(deltaEvents[1]).toContain('dunia');
    expect(writes.some((w) => w.startsWith('event: metadata'))).toBe(true);
    expect(writes.some((w) => w.startsWith('event: done'))).toBe(true);
    expect(writes[deltaEvents.length]).toContain('"inputTokens":7');
  });

  it('posts to /chat/completions with Bearer auth and include_usage', async () => {
    fetchMock.mockResolvedValue(sseResponse([frames.done]));
    await streamExternalCompletion(makeRequest(), 'https://gw.example.com/', 'secret-key', { write: () => {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gw.example.com/chat/completions'); // trailing slash trimmed
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('qwen3.7-flash-2026-07-15');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('max_tokens forwarded when inferenceConfig.maxTokens is set', async () => {
    fetchMock.mockResolvedValue(sseResponse([frames.done]));
    const req = makeRequest();
    (req.inferenceConfig as Record<string, unknown>).maxTokens = 512;
    await streamExternalCompletion(req, 'https://gw.example.com', 'k', { write: () => {} });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).max_tokens).toBe(512);
  });

  it('falls back to chars/4 token estimates when usage is missing', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"id":"1","choices":[{"delta":{"content":"abcdefgh"}}]}\n', frames.done]));
    const req = makeRequest(); // system 'Bantulah.' (9) counted in base AND inside messages → 9 + (9+4) = 22 chars
    const result = await streamExternalCompletion(req, 'https://gw.example.com', 'k', { write: () => {} });
    expect(result.inputTokens).toBe(Math.ceil(22 / 4)); // 6
    expect(result.outputTokens).toBe(Math.ceil(8 / 4)); // 2
  });

  it('non-2xx response throws a sanitized InferenceError (no key, no URL)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }));
    const err = await streamExternalCompletion(makeRequest(), 'https://gw.example.com', 'super-secret', { write: () => {} })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(InferenceError);
    const msg = String((err as Error).message);
    expect(msg).toContain('failed (401)');
    expect(msg).toContain('invalid api key');
    expect(msg).not.toContain('super-secret');
    expect(msg).not.toContain('gw.example.com');
  });

  it('network failure maps to an InferenceError (model_error)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const err = await streamExternalCompletion(makeRequest(), 'https://gw.example.com', 'k', { write: () => {} })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(InferenceError);
    expect((err as Error).message).toContain('unreachable');
  });

  it('reader interruption maps to an InferenceError, never a raw leak', async () => {
    const bad = new ReadableStream<Uint8Array>({
      pull() { throw new Error('upstream boom'); },
    });
    fetchMock.mockResolvedValue(new Response(bad, { status: 200 }));
    const err = await streamExternalCompletion(makeRequest(), 'https://gw.example.com', 'k', { write: () => {} })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(InferenceError);
    expect((err as Error).message).toContain('interrupted');
    expect((err as Error).message).not.toContain('upstream boom');
  });
});
