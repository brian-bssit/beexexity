/**
 * Tier-3 ReAct tool-loop tests (tasks 3-10 + Req 8). Global fetch is stubbed per round;
 * exercises the full DeepSeek-style wire contract: reasoning_content echo, index-merged
 * partial tool_calls, MAX_TOOL_ITERATIONS cap, summed usage, plain allowlist-off body,
 * final-only content persistence, and the B1 empty-content guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamExternalCompletion } from '../../src/services/external-chat.service.js';
import { InferenceError } from '../../src/services/inference.service.js';
import { AVAILABLE_TOOLS } from '../../src/services/tool-registry.service.js';
import type { ConversationInferenceRequest } from '../../src/types/session.types.js';

const enc = new TextEncoder();

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

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n`;
}

function makeRequest(): ConversationInferenceRequest {
  return {
    sessionId: 's1',
    userId: 'u1',
    modelId: 'deepseek-v4-flash-2026-09-08',
    system: undefined,
    messages: [{ role: 'user', content: [{ text: 'Jam berapa sekarang?' }] }],
    inferenceConfig: {},
  } as unknown as ConversationInferenceRequest;
}

/** One tool-requesting round: reasoning + partial tool_calls merged by index, usage in final chunk. */
function toolRound(reasoning: string, argsFragments: string[]) {
  const chunks: unknown[] = [{ choices: [{ delta: { reasoning_content: reasoning } }] }];
  argsFragments.forEach((af, i) => {
    const tc = i === 0
      ? { index: 0, id: 'call_1', type: 'function', function: { name: 'get_current_datetime', arguments: af } }
      : { index: 0, function: { arguments: af } }; // later fragments carry only argument text
    chunks.push({ choices: [{ delta: { tool_calls: [tc] } }] });
  });
  chunks.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  return chunks;
}

/** One final answer round: reasoning then streaming content, stop + usage. */
function finalRound(reasoning: string, contentParts: string[]) {
  const chunks: unknown[] = [{ choices: [{ delta: { reasoning_content: reasoning } }] }];
  for (const part of contentParts) chunks.push({ choices: [{ delta: { content: part } }] });
  chunks.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 8 } });
  return chunks;
}

function toFrames(chunks: unknown[]): string[] {
  return [...chunks.map((c) => frame(c)), 'data: [DONE]\n'];
}

describe('streamExternalCompletion (tools/thinking)', () => {
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

  it('echoes reasoning verbatim, merges partial tool_calls by index, sums usage, returns only final content', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(toFrames(toolRound('Cek waktu dulu.', ['{"t', 'z":"w"}']))))
      .mockResolvedValueOnce(sseResponse(toFrames(finalRound('Lalu jawab.', ['Waktu sekarang: ', 'siang.']))));

    const result = await streamExternalCompletion(makeRequest(), 'https://gw.example.com', 'secret', { write: (c) => writes.push(String(c)) }, AVAILABLE_TOOLS);

    // Final content only — reasoning never reaches the returned/audit-facing payload.
    expect(result.status).toBe('success');
    expect(result.assistantText).toBe('Waktu sekarang: siang.');
    expect(result.assistantText).not.toContain('Cek waktu dulu.');
    expect(result.assistantText).not.toContain('Lalu jawab.');

    // Summed usage across both rounds → one metadata event.
    expect(result.inputTokens).toBe(13);   // 10 + 3
    expect(result.outputTokens).toBe(13);  // 5 + 8
    const metadata = writes.filter((w) => w.startsWith('event: metadata'));
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toContain('"inputTokens":13');
    expect(metadata[0]).toContain('"outputTokens":13');
    expect(writes.filter((w) => w.startsWith('event: done'))).toHaveLength(1);

    // reasoning streamed per round; delta streamed only from the final round.
    expect(writes.filter((w) => w.startsWith('event: reasoning'))).toHaveLength(2);
    expect(writes.filter((w) => w.startsWith('event: delta'))).toHaveLength(2);
    expect(writes.some((w) => w.startsWith('event: tool_call'))).toBe(true);

    // Round 2 body: user + FULL assistant (content, verbatim reasoning, merged tool_calls) + tool result.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init2] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body2 = JSON.parse(String(init2.body));
    expect(body2.messages).toHaveLength(3);
    expect(body2.messages[1].role).toBe('assistant');
    expect(body2.messages[1].content).toBe('');
    expect(body2.messages[1].reasoning_content).toBe('Cek waktu dulu.'); // echoed verbatim incl. alongside tool_calls
    expect(body2.messages[1].tool_calls).toHaveLength(1);
    expect(body2.messages[1].tool_calls[0].id).toBe('call_1');
    expect(body2.messages[1].tool_calls[0].function.name).toBe('get_current_datetime');
    expect(body2.messages[1].tool_calls[0].function.arguments).toBe('{"tz":"w"}'); // partial args concatenated
    expect(body2.messages[2].role).toBe('tool');
    expect(body2.messages[2].tool_call_id).toBe('call_1');
    expect(typeof body2.messages[2].content).toBe('string');
    expect(body2.messages[2].content.length).toBeGreaterThan(0); // registry datetime result

    // Tools stay offered across rounds (model may call again) — stripped only at the cap.
    const [, init1] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init1.body)).tools).toEqual(AVAILABLE_TOOLS);
    expect(body2.tools).toEqual(AVAILABLE_TOOLS);
  });

  it('caps tool iterations at MAX_TOOL_ITERATIONS and forces a plain final answer', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(toFrames(toolRound('r1.', ['{}']))))
      .mockResolvedValueOnce(sseResponse(toFrames(toolRound('r2.', ['{}']))))
      .mockResolvedValueOnce(sseResponse(toFrames(toolRound('r3.', ['{}']))))
      .mockResolvedValueOnce(sseResponse(toFrames(finalRound('r4.', ['Selesai.']))));

    const result = await streamExternalCompletion(makeRequest(), 'https://gw.example.com', 'secret', { write: () => {} }, AVAILABLE_TOOLS);

    expect(fetchMock).toHaveBeenCalledTimes(4); // 3 tool rounds + 1 forced plain
    expect(result.assistantText).toBe('Selesai.');
    const [, lastInit] = fetchMock.mock.calls[3] as [string, RequestInit];
    const lastBody = JSON.parse(String(lastInit.body));
    expect(lastBody.tools).toBeUndefined(); // cap reached → tools stripped for the final answer
  });

  it('allowlist-off (no tools arg) keeps the request body plain — no tools field', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(toFrames(finalRound('r.', ['Halo.']))));

    await streamExternalCompletion(makeRequest(), 'https://gw.example.com', 'secret', { write: () => {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect('tools' in body).toBe(false);
    expect(body.messages).toHaveLength(1); // untouched history, no assistant/tool frames
    expect('reasoning_content' in body.messages[0]).toBe(false);
  });

  it('thinkingParams spread verbatim into the body when allowlisted model opts in', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(toFrames(finalRound('r.', ['Halo.']))));

    await streamExternalCompletion(
      makeRequest(),
      'https://gw.example.com',
      'secret',
      { write: () => {} },
      AVAILABLE_TOOLS,
      { enable_thinking: true }, // Qwen/SumoPod-style opt-in toggle
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.enable_thinking).toBe(true);
    expect(body.tools).toEqual(AVAILABLE_TOOLS);
    // and absent when not passed (allowlist-off path stays plain)
    expect(Object.keys(body).includes('thinkingParams')).toBe(false);
  });

  it('B1 empty-content (stop, reasoning only) → sanitized InferenceError, no metadata/done', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(toFrames([
      { choices: [{ delta: { reasoning_content: 'berpikir…' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 0 } },
    ])));

    const err = await streamExternalCompletion(makeRequest(), 'https://gw.example.com', 'super-secret-key', { write: (c) => writes.push(String(c)) })
      .then(() => null, (e) => e);

    expect(err).toBeInstanceOf(InferenceError);
    expect(String((err as Error).message)).toContain('exhausted its reasoning budget');
    expect(String((err as Error).message)).not.toContain('super-secret-key');
    expect(String((err as Error).message)).not.toContain('gw.example.com');
    expect(writes.some((w) => w.startsWith('event: metadata'))).toBe(false); // no success framing
    expect(writes.some((w) => w.startsWith('event: delta'))).toBe(false);     // never an empty delta
  });

  it('reasoning-only truncation without explicit stop also triggers the B1 guard', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(toFrames([
      { choices: [{ delta: { reasoning_content: 'memikirkan…' } }] },
      { choices: [{ delta: {} }], usage: { prompt_tokens: 4, completion_tokens: 1 } },
    ])));

    const err = await streamExternalCompletion(makeRequest(), 'https://gw.example.com', 'k', { write: () => {} })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(InferenceError);
    expect(String((err as Error).message)).toContain('exhausted its reasoning budget');
  });
});
