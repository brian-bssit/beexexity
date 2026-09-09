import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import type { InferenceRequest } from '../../src/types/inference.types.js';

// Mock the database module for validateModelId access checks
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }), // no access rows → public model
}));

// Mock the @aws-sdk/client-bedrock-runtime module
vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  const mockSend = vi.fn();
  return {
    BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
    })),
    ConverseStreamCommand: vi.fn().mockImplementation((input) => input),
    __mockSend: mockSend,
  };
});

import { validateModelId, generate } from '../../src/services/inference.service.js';
import type { ConversationInferenceRequest } from '../../src/types/session.types.js';

// Get access to mock send function
const { __mockSend: mockSend } = await import('@aws-sdk/client-bedrock-runtime') as any;

function createMockResponse(): Response & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    write: vi.fn((data: string) => {
      written.push(data);
      return true;
    }),
  } as unknown as Response & { written: string[] };
}

/** Helper to create an async iterable stream from events */
async function* createMockStream(events: any[]) {
  for (const event of events) {
    yield event;
  }
}

describe('inference.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateModelId', () => {
    it('should return default model when no modelId provided', async () => {
      await expect(validateModelId()).resolves.toBe('qwen.qwen3-32b-v1:0');
      await expect(validateModelId('')).resolves.toBe('qwen.qwen3-32b-v1:0');
      await expect(validateModelId(undefined)).resolves.toBe('qwen.qwen3-32b-v1:0');
    });

    it('should accept valid model IDs', async () => {
      await expect(validateModelId('openai.gpt-oss-120b-1:0')).resolves.toBe('openai.gpt-oss-120b-1:0');
      await expect(validateModelId('qwen.qwen3-32b-v1:0')).resolves.toBe('qwen.qwen3-32b-v1:0');
    });

    it('should reject invalid model IDs with statusCode 400', async () => {
      try {
        await validateModelId('invalid-model');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('Invalid model');
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_MODEL');
      }
    });
  });

  describe('generate', () => {
    const baseRequest: InferenceRequest = {
      maskedPrompt: 'Hello, how are you?',
      modelId: 'qwen.qwen3-32b-v1:0',
      userId: 'user-123',
    };

    it('should stream contentBlockDelta events as SSE delta events', async () => {
      const mockRes = createMockResponse();
      const streamEvents = [
        { contentBlockDelta: { delta: { text: 'Hello' } } },
        { contentBlockDelta: { delta: { text: ' world' } } },
        { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
        { messageStop: { stopReason: 'end_turn' } },
      ];

      mockSend.mockResolvedValueOnce({ stream: createMockStream(streamEvents) });

      const result = await generate(baseRequest, mockRes);

      expect(mockRes.written[0]).toBe('event: delta\ndata: {"type":"text","content":"Hello"}\n\n');
      expect(mockRes.written[1]).toBe('event: delta\ndata: {"type":"text","content":" world"}\n\n');
      expect(result.status).toBe('success');
    });

    it('should stream metadata events with token counts', async () => {
      const mockRes = createMockResponse();
      const streamEvents = [
        { contentBlockDelta: { delta: { text: 'Hi' } } },
        { metadata: { usage: { inputTokens: 42, outputTokens: 156 } } },
        { messageStop: { stopReason: 'end_turn' } },
      ];

      mockSend.mockResolvedValueOnce({ stream: createMockStream(streamEvents) });

      const result = await generate(baseRequest, mockRes);

      expect(mockRes.written[1]).toBe('event: metadata\ndata: {"inputTokens":42,"outputTokens":156}\n\n');
      expect(result.inputTokens).toBe(42);
      expect(result.outputTokens).toBe(156);
    });

    it('should stream done event on messageStop', async () => {
      const mockRes = createMockResponse();
      const streamEvents = [
        { contentBlockDelta: { delta: { text: 'Done' } } },
        { metadata: { usage: { inputTokens: 5, outputTokens: 1 } } },
        { messageStop: { stopReason: 'end_turn' } },
      ];

      mockSend.mockResolvedValueOnce({ stream: createMockStream(streamEvents) });

      await generate(baseRequest, mockRes);

      expect(mockRes.written[2]).toBe('event: done\ndata: {}\n\n');
    });

    it('should return InferenceResult with correct token counts and status', async () => {
      const mockRes = createMockResponse();
      const streamEvents = [
        { contentBlockDelta: { delta: { text: 'Response' } } },
        { metadata: { usage: { inputTokens: 20, outputTokens: 30 } } },
        { messageStop: { stopReason: 'end_turn' } },
      ];

      mockSend.mockResolvedValueOnce({ stream: createMockStream(streamEvents) });

      const result = await generate(baseRequest, mockRes);

      expect(result).toEqual({
        status: 'success',
        inputTokens: 20,
        outputTokens: 30,
        modelId: 'qwen.qwen3-32b-v1:0',
      });
    });

    it('should pass inferenceConfig to ConverseStreamCommand when provided', async () => {
      const { ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');
      const mockRes = createMockResponse();
      const requestWithConfig: InferenceRequest = {
        ...baseRequest,
        inferenceConfig: {
          maxTokens: 1024,
          temperature: 0.7,
          topP: 0.9,
        },
      };

      const streamEvents = [
        { metadata: { usage: { inputTokens: 5, outputTokens: 3 } } },
        { messageStop: { stopReason: 'end_turn' } },
      ];

      mockSend.mockResolvedValueOnce({ stream: createMockStream(streamEvents) });

      await generate(requestWithConfig, mockRes);

      expect(ConverseStreamCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'qwen.qwen3-32b-v1:0',
          messages: [
            {
              role: 'user',
              content: [{ text: 'Hello, how are you?' }],
            },
          ],
          inferenceConfig: {
            maxTokens: 1024,
            temperature: 0.7,
            topP: 0.9,
          },
        }),
      );
    });

    it('should handle empty delta text gracefully', async () => {
      const mockRes = createMockResponse();
      const streamEvents = [
        { contentBlockDelta: { delta: {} } },
        { metadata: { usage: { inputTokens: 1, outputTokens: 0 } } },
        { messageStop: { stopReason: 'end_turn' } },
      ];

      mockSend.mockResolvedValueOnce({ stream: createMockStream(streamEvents) });

      const result = await generate(baseRequest, mockRes);

      expect(mockRes.written[0]).toBe('event: delta\ndata: {"type":"text","content":""}\n\n');
      expect(result.status).toBe('success');
    });

    it('should handle missing usage in metadata gracefully', async () => {
      const mockRes = createMockResponse();
      const streamEvents = [
        { metadata: {} },
        { messageStop: { stopReason: 'end_turn' } },
      ];

      mockSend.mockResolvedValueOnce({ stream: createMockStream(streamEvents) });

      const result = await generate(baseRequest, mockRes);

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
    });

    it('should handle stream with no events', async () => {
      const mockRes = createMockResponse();
      mockSend.mockResolvedValueOnce({ stream: createMockStream([]) });

      const result = await generate(baseRequest, mockRes);

      expect(result.status).toBe('success');
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(mockRes.written).toHaveLength(0);
    });

    it('should handle null stream response', async () => {
      const mockRes = createMockResponse();
      mockSend.mockResolvedValueOnce({ stream: null });

      const result = await generate(baseRequest, mockRes);

      expect(result.status).toBe('success');
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(mockRes.written).toHaveLength(0);
    });
  });
});

describe('generate tool loop (tier1-tools)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const convRequest = (): ConversationInferenceRequest => ({
    messages: [{ role: 'user', content: [{ text: 'cari SOP pengajuan cuti' }] }],
    modelId: 'qwen.qwen3-235b-a22b-2507-v1:0',
    userId: 'user-1',
    system: 'You are a helpful assistant. You have tools.',
    inferenceConfig: { maxTokens: 128 },
  });

  const toolSpec = () => [{ toolSpec: { name: 'search_internal_knowledge' } }] as any;
  const toolUseRound = (): any[] => [
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tu-1', name: 'search_internal_knowledge' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"query":' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"SOP pengajuan cuti"}' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'tool_use' } },
  ];

  it('streams text→toolUse→text, emits one tool_call + single metadata/done, returns toolCallsMeta', async () => {
    const mockRes = createMockResponse();
    const execTool = vi.fn(async () => '[Sumber: SOP Cuti]\nLangkah pengajuan: 1) portal 2) form FC-01');

    mockSend.mockResolvedValueOnce({ stream: createMockStream(toolUseRound()) });
    mockSend.mockResolvedValueOnce({
      stream: createMockStream([
        { contentBlockDelta: { delta: { text: 'Sesuai SOP, ' } } },
        { contentBlockDelta: { delta: { text: 'ajukan via portal HR.' } } },
        { metadata: { usage: { inputTokens: 7, outputTokens: 5 } } },
        { messageStop: { stopReason: 'end_turn' } },
      ]),
    });

    const result = await generate(convRequest(), mockRes, {
      tools: toolSpec(),
      execTool,
      maxIterations: 3,
    }) as any;

    const written = mockRes.written.join('\n');
    // tool args reassembled across fragments into one object
    expect(execTool).toHaveBeenCalledTimes(1);
    expect(execTool).toHaveBeenCalledWith('search_internal_knowledge', { query: 'SOP pengajuan cuti' });
    // live text deltas + tool badge + exactly ONE metadata and ONE done
    expect(written).toContain('event: tool_call');
    expect(written).toContain('Sesuai SOP, ');
    expect(written.match(/event: metadata/g)).toHaveLength(1);
    expect(written.match(/event: done/g)).toHaveLength(1);
    // accumulated assistant text across rounds
    expect(result.assistantText).toBe('Sesuai SOP, ajukan via portal HR.');
    expect(result.inputTokens).toBe(7);
    expect(result.outputTokens).toBe(5);
    // audit metadata: masked args, chunk count from [Sumber:], size in chars
    expect(result.toolCallsMeta).toHaveLength(1);
    expect(result.toolCallsMeta[0].tool).toBe('search_internal_knowledge');
    expect(result.toolCallsMeta[0].args_masked).toContain('SOP pengajuan cuti');
    expect(result.toolCallsMeta[0].result_chunks).toBe(1);
    expect(result.toolCallsMeta[0].result_size).toBeGreaterThan(0);
    expect(typeof result.toolCallsMeta[0].duration_ms).toBe('number');
  });

  it('runs N tool rounds then 1 plain forced round with tools stripped', async () => {
    const mockRes = createMockResponse();
    const execTool = vi.fn(async () => 'hasil kosong');

    // round 0: tool use; round 1 (forced plain): answers directly even though it "wants" another tool
    mockSend.mockResolvedValueOnce({ stream: createMockStream(toolUseRound()) });
    mockSend.mockResolvedValueOnce({
      stream: createMockStream([
        { contentBlockDelta: { delta: { text: 'Jawaban final.' } } },
        { metadata: { usage: { inputTokens: 1, outputTokens: 2 } } },
        { messageStop: { stopReason: 'end_turn' } },
      ]),
    });

    await generate(convRequest(), mockRes, { tools: toolSpec(), execTool, maxIterations: 1 });

    expect(mockSend).toHaveBeenCalledTimes(2);
    const firstCmd = mockSend.mock.calls[0][0] as any;
    const secondCmd = mockSend.mock.calls[1][0] as any;
    expect(firstCmd.toolConfig.tools).toHaveLength(1); // round 0 has tools
    expect(secondCmd.toolConfig).toBeUndefined(); // forced final round strips tools
    const written = mockRes.written.join('\n');
    expect(written.match(/event: done/g)).toHaveLength(1);
  });

  it('tool-execution failure falls through gracefully — still a single done, never rejects', async () => {
    const mockRes = createMockResponse();
    const execTool = vi.fn(async () => { throw new Error('boom'); });

    mockSend.mockResolvedValueOnce({ stream: createMockStream(toolUseRound()) });
    mockSend.mockResolvedValueOnce({
      stream: createMockStream([
        { contentBlockDelta: { delta: { text: 'Maaf, coba lagi.' } } },
        { metadata: { usage: { inputTokens: 2, outputTokens: 2 } } },
        { messageStop: { stopReason: 'end_turn' } },
      ]),
    });

    const result = await generate(convRequest(), mockRes, {
      tools: toolSpec(), execTool, maxIterations: 3,
    }) as any;

    expect(result.status).toBe('success');
    const written = mockRes.written.join('\n');
    expect(written.match(/event: done/g)).toHaveLength(1);
    expect(written.match(/event: metadata/g)).toHaveLength(1);
  });

  it('no toolUse on round 0 → single shot, one send call', async () => {
    const mockRes = createMockResponse();
    mockSend.mockResolvedValueOnce({
      stream: createMockStream([
        { contentBlockDelta: { delta: { text: 'langsung jawab.' } } },
        { metadata: { usage: { inputTokens: 3, outputTokens: 3 } } },
        { messageStop: { stopReason: 'end_turn' } },
      ]),
    });

    await generate(convRequest(), mockRes, { tools: toolSpec(), execTool: vi.fn(), maxIterations: 3 });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('regression: 2-arg generate ≡ 3rd-arg-undefined generate (byte-identical stream, no toolConfig)', async () => {
    const shared = [
      { contentBlockDelta: { delta: { text: 'Halo ' } } },
      { contentBlockDelta: { delta: { text: 'dunia' } } },
      { metadata: { usage: { inputTokens: 4, outputTokens: 2 } } },
      { messageStop: { stopReason: 'end_turn' } },
    ];

    const resA = createMockResponse();
    mockSend.mockResolvedValueOnce({ stream: createMockStream(shared) });
    const a = await generate(convRequest(), resA) as any;

    const resB = createMockResponse();
    mockSend.mockResolvedValueOnce({ stream: createMockStream(shared) });
    const b = await generate(convRequest(), resB, undefined) as any;

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(resA.written).toEqual(resB.written); // identical SSE bytes
    expect(a.assistantText).toBe(b.assistantText);
    expect((mockSend.mock.calls[0][0] as any).toolConfig).toBeUndefined();
    expect(b.toolCallsMeta).toBeUndefined(); // non-tool path never fabricates meta
  });
});
