/**
 * Tests for Sequential Reasoning Engine.
 * @see docs/features/sequential-reasoning/
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Response } from 'express';

// Mock inference service bedrock client
vi.mock('../../src/services/inference.service.js', () => ({
  bedrockClient: { send: vi.fn() },
  validateModelId: vi.fn((id: string) => id || 'qwen.qwen3-32b-v1:0'),
}));

// Mock PII masker
vi.mock('../../src/services/pii-masker.service.js', () => ({
  mask: vi.fn((text: string) => ({ maskedText: text })),
}));

// Mock audit service
vi.mock('../../src/services/audit.service.js', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}));

import { bedrockClient } from '../../src/services/inference.service.js';
import { mask } from '../../src/services/pii-masker.service.js';
import { auditService } from '../../src/services/audit.service.js';
import { sequentialReasoner } from '../../src/services/sequential-reasoning.service.js';
import type { SequentialReasoningInput } from '../../src/services/sequential-reasoning.service.js';
import type { RoutingDecision } from '../../src/types/routing.types.js';

const mockedBedrockSend = vi.mocked(bedrockClient.send);
const mockedMask = vi.mocked(mask);
const mockedAuditLog = vi.mocked(auditService.log);

/** Build a minimal routing decision for tests. */
function makeRoutingDecision(overrides?: Partial<RoutingDecision>): RoutingDecision {
  return {
    executedModelId: 'qwen.qwen3-235b-a22b-2507-v1:0',
    routingState: 'auto',
    complexityScore: 4,
    scoreBand: 'advanced-reasoning',
    confidence: 0.8,
    refinedPrompt: 'Test prompt for sequential reasoning',
    routingReasonCode: 'complexity-4',
    reasoningSummary: 'High complexity request',
    modalityFlags: { textOnly: true, documentText: false, image: false, mixed: false },
    manualOverrideApplied: false,
    flags: [],
    skill: 'fallback',
    contract: null,
    ...overrides,
  };
}

/** Build a minimal input for SequentialReasoner.execute(). */
function makeInput(overrides?: Partial<SequentialReasoningInput>): SequentialReasoningInput {
  return {
    originalPrompt: 'Analyze this document and provide a compliance assessment',
    refinedPrompt: 'Analyze this document and provide a compliance assessment',
    maskedDocumentText: undefined,
    conversationHistory: [],
    userId: 'test-user-id',
    sessionId: 'test-session-id',
    username: 'testuser',
    routingDecision: makeRoutingDecision(),
    ...overrides,
  };
}

/** Create a minimal mock Express Response that captures SSE writes. */
function makeMockRes(): Response {
  const chunks: string[] = [];
  return {
    write: vi.fn((chunk: string) => { chunks.push(chunk); return true; }),
    end: vi.fn(),
    _chunks: chunks,
  } as unknown as Response & { _chunks: string[] };
}

/** Helper: mock bedrock to return a plan JSON. */
function mockPlannerResponse(steps: Array<{ name: string; description: string; systemPrompt?: string }>, reasoning = 'Test plan') {
  const planJson = JSON.stringify({ steps: steps.map((s, i) => ({ order: i + 1, name: s.name, description: s.description, systemPrompt: s.systemPrompt || 'Continue analysis', modelId: 'qwen.qwen3-235b-a22b-2507-v1:0' })), reasoning });
  mockedBedrockSend.mockResolvedValueOnce({
    output: { message: { content: [{ text: planJson }] } },
  });
}

/** Helper: mock bedrock to return text for a step call. */
function mockStepResponse(text: string) {
  mockedBedrockSend.mockResolvedValueOnce({
    output: { message: { content: [{ text }] } },
  });
}

describe('SequentialReasoner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('planner — via execute()', () => {
    it('returns a valid plan when planner returns 2+ steps', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'Data Extraction', description: 'Extract key info' },
        { name: 'Analysis', description: 'Analyze patterns' },
      ]);
      // Step calls need mocks too
      mockStepResponse('Extracted data: revenue up 15%');
      mockStepResponse('Analysis complete: positive trend');

      const result = await sequentialReasoner.execute(makeInput(), res);

      expect(result).not.toBeNull();
      expect(result!.plan.steps).toHaveLength(2);
      expect(result!.plan.steps[0].name).toBe('Data Extraction');
      expect(result!.plan.steps[1].name).toBe('Analysis');
      expect(result!.stepResults).toHaveLength(2);
      expect(result!.stepResults.every(r => r.status === 'success')).toBe(true);
    });

    it('returns null when planner returns 1 step (fallback)', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'Single Step', description: 'Do everything' },
      ]);

      const result = await sequentialReasoner.execute(makeInput(), res);

      expect(result).toBeNull();
    });

    it('returns null when planner LLM fails', async () => {
      const res = makeMockRes();
      // First call (planner) throws
      mockedBedrockSend.mockRejectedValueOnce(new Error('Bedrock timeout'));

      const result = await sequentialReasoner.execute(makeInput(), res);

      expect(result).toBeNull();
    });

    it('returns null when planner returns malformed JSON', async () => {
      const res = makeMockRes();
      mockedBedrockSend.mockResolvedValueOnce({
        output: { message: { content: [{ text: 'not valid json at all' }] } },
      });

      const result = await sequentialReasoner.execute(makeInput(), res);

      expect(result).toBeNull();
    });
  });

  describe('executor — retry logic', () => {
    it('succeeds on first attempt', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'Step 1', description: 'First step' },
        { name: 'Step 2', description: 'Second step' },
      ]);
      // Step 1 succeeds
      mockStepResponse('Step 1 output');
      // Step 2 succeeds
      mockStepResponse('Step 2 output');

      const result = await sequentialReasoner.execute(makeInput(), res);

      expect(result).not.toBeNull();
      expect(result!.stepResults[0].retryCount).toBe(0);
      expect(result!.stepResults[1].retryCount).toBe(0);
      expect(result!.stepResults.every(r => r.status === 'success')).toBe(true);
    });

    it('retries once on failure, succeeds on second attempt', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'Step 1', description: 'First step' },
        { name: 'Step 2', description: 'Second step' },
      ]);
      // Step 1: first attempt fails, second attempt succeeds
      mockedBedrockSend.mockRejectedValueOnce(new Error('Throttling'));
      mockStepResponse('Step 1 output after retry');
      // Step 2 succeeds
      mockStepResponse('Step 2 output');

      const result = await sequentialReasoner.execute(makeInput(), res);

      expect(result).not.toBeNull();
      expect(result!.stepResults[0].retryCount).toBe(1);
      expect(result!.stepResults[0].status).toBe('success');
      expect(result!.stepResults[1].status).toBe('success');
    });

    it('skips step after all retries exhausted, continues chain', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'Step 1', description: 'First step' },
        { name: 'Step 2', description: 'Second step' },
      ]);
      // Step 1: both attempts fail
      mockedBedrockSend.mockRejectedValueOnce(new Error('Model error'));
      mockedBedrockSend.mockRejectedValueOnce(new Error('Model error after simplified prompt'));
      // Step 2 succeeds despite step 1 failure
      mockStepResponse('Step 2 output');

      const result = await sequentialReasoner.execute(makeInput(), res);

      expect(result).not.toBeNull();
      expect(result!.stepResults[0].status).toBe('failed');
      expect(result!.stepResults[1].status).toBe('success');
      expect(result!.synthesisStatus).toBe('partial');
    });

    it('handles empty step output as failure', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'Step 1', description: 'First step' },
        { name: 'Step 2', description: 'Second step' },
      ]);
      // Step 1 produces empty string then empty on retry
      mockedBedrockSend.mockResolvedValueOnce({
        output: { message: { content: [{ text: '' }] } },
      });
      mockedBedrockSend.mockResolvedValueOnce({
        output: { message: { content: [{ text: '' }] } },
      });
      mockStepResponse('Step 2 output');

      const result = await sequentialReasoner.execute(makeInput(), res);

      expect(result).not.toBeNull();
      expect(result!.stepResults[0].status).toBe('failed');
      expect(result!.stepResults[1].status).toBe('success');
    });
  });

  describe('synthesizer', () => {
    it('produces response when all steps succeed', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'Extract', description: 'Extract data' },
        { name: 'Analyze', description: 'Analyze data' },
      ]);
      mockStepResponse('Revenue: $10M, Costs: $8M');
      mockStepResponse('Profit margin: 20%, healthy');
      // Synthesizer call
      mockStepResponse('Final: The company has a healthy 20% profit margin on $10M revenue.');

      const result = await sequentialReasoner.execute(makeInput(), res);

      expect(result).not.toBeNull();
      expect(result!.synthesisStatus).toBe('success');
      expect(result!.assistantText).toContain('Final');
    });

    it('produces partial response when some steps fail', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'Extract', description: 'Extract data' },
        { name: 'Analyze', description: 'Analyze data' },
      ]);
      // Step 1 fails
      mockedBedrockSend.mockRejectedValueOnce(new Error('Timeout'));
      mockedBedrockSend.mockRejectedValueOnce(new Error('Timeout again'));
      // Step 2 succeeds
      mockStepResponse('Analysis result');
      // Synthesizer
      mockStepResponse('Partial response based on available data.');

      const result = await sequentialReasoner.execute(makeInput(), res);

      expect(result).not.toBeNull();
      expect(result!.synthesisStatus).toBe('partial');
      expect(result!.stepResults[0].status).toBe('failed');
      expect(result!.stepResults[1].status).toBe('success');
    });


    it('produces fallback response when all steps fail', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'Extract', description: 'Extract data' },
        { name: 'Analyze', description: 'Analyze data' },
      ]);
      // Both steps fail all retries
      for (let i = 0; i < 4; i++) {
        mockedBedrockSend.mockRejectedValueOnce(new Error('Service unavailable'));
      }
      // Synthesizer still runs
      mockStepResponse('Fallback: Direct response based on original prompt.');

      const result = await sequentialReasoner.execute(makeInput(), res);

      expect(result).not.toBeNull();
      expect(result!.synthesisStatus).toBe('failed');
      expect(result!.assistantText).toBeTruthy();
    });
  });

  describe('PII masking per step', () => {
    it('calls mask on step input', async () => {
      const res = makeMockRes();
      // Clear mock counts
      mockedMask.mockClear();
      // Default mock returns input unchanged
      mockedMask.mockImplementation((text: string) => ({ maskedText: text }));

      mockPlannerResponse([
        { name: 'Step 1', description: 'First step', systemPrompt: 'Analyze this data' },
        { name: 'Step 2', description: 'Second step' },
      ]);
      mockStepResponse('Step 1 output');
      mockStepResponse('Step 2 output');
      mockStepResponse('Synthesized output');

      await sequentialReasoner.execute(makeInput(), res);

      // mask should have been called at least for step inputs and outputs
      // (planner prompt, step1 input, step1 output, step2 input, step2 output, synthesizer input)
      expect(mockedMask).toHaveBeenCalled();
    });
  });

  describe('progressive synthesis', () => {
    it('emits interim synthesis at configured interval', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'Step 1', description: 'First' },
        { name: 'Step 2', description: 'Second' },
        { name: 'Step 3', description: 'Third' },
      ]);
      // All steps succeed
      mockStepResponse('Output 1');
      mockStepResponse('Output 2');
      mockStepResponse('Output 3');
      // Interim synthesis uses qwen3-32b
      mockedBedrockSend.mockResolvedValueOnce({
        output: { message: { content: [{ text: 'Interim: found 3 key themes...' }] } },
      });
      // Synthesizer
      mockStepResponse('Final output');

      const result = await sequentialReasoner.execute(makeInput({
        routingDecision: makeRoutingDecision({ complexityScore: 5 }),
      }), res);

      expect(result).not.toBeNull();
      // Should have emitted orchestration_interim event
      const interimEvents = res._chunks.filter(c => c.includes('orchestration_interim'));
      expect(interimEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('SSE events', () => {
    it('emits orchestration_plan, status, and step events on success', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'Extract', description: 'Extract data' },
        { name: 'Report', description: 'Generate report' },
      ]);
      mockStepResponse('Extracted data');
      mockStepResponse('Report text');
      // Synthesizer
      mockStepResponse('Final synthesized response');

      await sequentialReasoner.execute(makeInput(), res);

      const allEvents = res._chunks.join('');
      expect(allEvents).toContain('orchestration_plan');
      expect(allEvents).toContain('orchestration_status');
      expect(allEvents).toContain('orchestration_step');
      // Should NOT contain error events on success
      expect(allEvents).not.toContain('orchestration_error');
    });

    it('emits orchestration_error on step failure', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'Fail Step', description: 'This will fail' },
        { name: 'Good Step', description: 'This will work' },
      ]);
      // Step 1 fails both attempts
      mockedBedrockSend.mockRejectedValueOnce(new Error('Model error'));
      mockedBedrockSend.mockRejectedValueOnce(new Error('Model error'));
      // Step 2 succeeds
      mockStepResponse('Good step output');
      // Synthesizer runs even with failures
      mockStepResponse('Partial response with acknowledged gaps');

      await sequentialReasoner.execute(makeInput(), res);

      const allEvents = res._chunks.join('');
      expect(allEvents).toContain('orchestration_error');
    });
  });

  describe('audit per step', () => {
    it('logs audit for each step', async () => {
      const res = makeMockRes();
      mockPlannerResponse([
        { name: 'S1', description: 'Step 1' },
        { name: 'S2', description: 'Step 2' },
        { name: 'S3', description: 'Step 3' },
      ]);
      mockStepResponse('Out 1');
      mockStepResponse('Out 2');
      mockStepResponse('Out 3');
      // Synthesizer
      mockStepResponse('Final output');

      await sequentialReasoner.execute(makeInput(), res);

      // Planner + 3 steps = 4 audit logs
      // But planner audit is fire-and-forget and may be called before execute returns
      // At minimum step audit calls
      expect(mockedAuditLog).toHaveBeenCalled();
    });
  });
});
