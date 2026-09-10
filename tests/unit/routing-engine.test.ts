/**
 * Tests for sovereign-tier routing (Phase 2, on Tahap 1 deterministic auto).
 * Covers selectAutoModel: restricted (PII/lexicon) → auto-tier-1; open → auto-fixed-model;
 * Tier-3 candidate only when the gateway is on + text-only + a default model exists.
 * Manual + passthrough branches preserved. DB/LLM boundaries are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RoutingInput } from '../../src/types/routing.types.js';
import { DEFAULT_MODEL } from '../../src/types/inference.types.js';
import { config } from '../../src/config/index.js';
import { selectAutoModel, routeRequest } from '../../src/services/routing-engine.service.js';
import { checkModelAccess } from '../../src/services/inference.service.js';
import { getRestrictedTerms } from '../../src/services/restricted-terms.service.js';
import { getDefaultTier3Model } from '../../src/services/tier3.service.js';

// Mock the DB/LLM boundary — everything else runs real.
vi.mock('../../src/services/inference.service.js', () => ({
  checkModelAccess: vi.fn(),
}));
vi.mock('../../src/services/restricted-terms.service.js', () => ({
  getRestrictedTerms: vi.fn(),
  listTerms: vi.fn(),
  addTerm: vi.fn(),
  deleteTerm: vi.fn(),
}));
vi.mock('../../src/services/tier3.service.js', () => ({
  getDefaultTier3Model: vi.fn(),
  isEnabled: vi.fn(),
  listModels: vi.fn(),
  setModels: vi.fn(),
}));

const mockedCheckModelAccess = vi.mocked(checkModelAccess);
const mockedGetRestrictedTerms = vi.mocked(getRestrictedTerms);
const mockedGetDefaultTier3Model = vi.mocked(getDefaultTier3Model);

// config is `as const` readonly — tests relax just the runtime fields they drive.
const gateway = config.routing.externalTier3 as { enabled: boolean };

function makeInput(overrides?: Partial<RoutingInput>): RoutingInput {
  return {
    originalPrompt: 'test prompt',
    maskedDocumentText: undefined,
    hasImages: false,
    imageModelRequired: false,
    routingState: 'auto',
    userId: 'test-user',
    ...overrides,
  } as RoutingInput;
}

function setGateway(on: boolean, defaultModel: string | null): void {
  gateway.enabled = on;
  mockedGetDefaultTier3Model.mockResolvedValue(defaultModel);
}

describe('classifySovereignTier → selectAutoModel', () => {
  beforeEach(() => {
    mockedCheckModelAccess.mockReset().mockResolvedValue(true);
    mockedGetRestrictedTerms.mockReset().mockResolvedValue([]);
    mockedGetDefaultTier3Model.mockReset().mockResolvedValue(null);
    gateway.enabled = false;
  });

  it('open request, no env → byte-identical to Tahap 1 (auto-fixed-model, no flags)', async () => {
    const sel = await selectAutoModel({ userId: 'u1', hasImages: false, prompt: 'test prompt' });
    expect(sel.modelId).toBe(config.routing.autoModelId);
    expect(sel.reasonCode).toBe('auto-fixed-model');
    expect(sel.flags).toEqual([]);
    expect(mockedCheckModelAccess).toHaveBeenCalledTimes(1);
    expect(mockedCheckModelAccess).toHaveBeenCalledWith('u1', config.routing.autoModelId);
  });

  it('PII detected → restricted private (auto-tier-1, sovereign-tier-1), never T3', async () => {
    const sel = await selectAutoModel({ userId: 'u1', hasImages: false, prompt: 'test prompt', piiDetected: true });
    expect(sel.modelId).toBe(config.routing.autoModelId);
    expect(sel.reasonCode).toBe('auto-tier-1');
    expect(sel.flags).toEqual(['sovereign-tier-1']);
  });

  it('restricted-word hit (case-insensitive substring) → auto-tier-1', async () => {
    mockedGetRestrictedTerms.mockResolvedValue(['rahasia', 'internal']);
    const sel = await selectAutoModel({ userId: 'u1', hasImages: false, prompt: 'Data RAHASIA bank', documentText: undefined });
    expect(sel.reasonCode).toBe('auto-tier-1');
    expect(sel.flags).toEqual(['sovereign-tier-1']);
    expect(mockedGetRestrictedTerms).toHaveBeenCalled();
  });

  it('restricted word inside masked document text also forces private', async () => {
    mockedGetRestrictedTerms.mockResolvedValue(['strategi pricing']);
    const sel = await selectAutoModel({
      userId: 'u1', hasImages: false, prompt: 'ringkas dokumen ini', documentText: '…strategi PRICING 2027…',
    });
    expect(sel.reasonCode).toBe('auto-tier-1');
  });

  it('gateway on + default model + open text → tier3-candidate (model still private autoModelId)', async () => {
    setGateway(true, 'MiniMax-M2.7-highspeed');
    const sel = await selectAutoModel({ userId: 'u1', hasImages: false, prompt: 'tulis puisi' });
    expect(sel.reasonCode).toBe('auto-fixed-model');
    expect(sel.flags).toContain('tier3-candidate');
    expect(sel.flags).not.toContain('sovereign-tier-3'); // finalize happens post-retrieval
    expect(sel.modelId).toBe(config.routing.autoModelId);
    expect(mockedGetDefaultTier3Model).toHaveBeenCalled();
  });

  it('restricted + gateway on → auto-tier-1, candidate never set', async () => {
    setGateway(true, 'MiniMax-M2.7-highspeed');
    const sel = await selectAutoModel({ userId: 'u1', hasImages: false, prompt: 'x', piiDetected: true });
    expect(sel.reasonCode).toBe('auto-tier-1');
    expect(sel.flags).toEqual(['sovereign-tier-1']);
    expect(sel.flags).not.toContain('tier3-candidate');
    expect(mockedGetDefaultTier3Model).not.toHaveBeenCalled();
  });

  it('session-carried internal document blocks the candidate and flags it', async () => {
    setGateway(true, 'MiniMax-M2.7-highspeed');
    const sel = await selectAutoModel({
      userId: 'u1', hasImages: false, prompt: 'apa kesimpulannya?',
      documentText: 'isi dokumen internal', documentTextFromSession: true,
    });
    expect(sel.reasonCode).toBe('auto-fixed-model');
    expect(sel.flags).toContain('sovereign-internal-document');
    expect(sel.flags).not.toContain('tier3-candidate');
    expect(mockedGetDefaultTier3Model).not.toHaveBeenCalled();
  });

  it('a follow-up turn carrying the session document never becomes a Tier-3 candidate', async () => {
    setGateway(true, 'MiniMax-M2.7-highspeed');
    const d = await routeRequest(makeInput({
      originalPrompt: 'ringkas poin utamanya',
      maskedDocumentText: 'isi dokumen internal',
      documentTextFromSession: true,
    }));
    expect(d.flags).not.toContain('tier3-candidate');
    expect(d.flags).toContain('sovereign-internal-document');
    expect(d.modalityFlags.documentText).toBe(true);
    expect(d.modalityFlags.textOnly).toBe(false);
  });

  it('gateway on but no default model → no candidate', async () => {
    setGateway(true, null);
    const sel = await selectAutoModel({ userId: 'u1', hasImages: false, prompt: 'y' });
    expect(sel.flags).toEqual([]);
  });

  it('gateway on but multipart (documentText) → no candidate (T3 text-only)', async () => {
    setGateway(true, 'MiniMax-M2.7-highspeed');
    const sel = await selectAutoModel({ userId: 'u1', hasImages: false, prompt: 'z', documentText: 'doc text' });
    expect(sel.flags).toEqual([]);
  });

  it('access denied on open model → DEFAULT_MODEL, no candidate (conservative)', async () => {
    setGateway(true, 'MiniMax-M2.7-highspeed');
    mockedCheckModelAccess.mockResolvedValue(false);
    const sel = await selectAutoModel({ userId: 'u1', hasImages: false, prompt: 'w' });
    expect(sel.modelId).toBe(DEFAULT_MODEL);
    expect(sel.reasonCode).toBe('auto-access-denied');
    expect(sel.flags).toEqual(['auto-access-denied']);
  });

  it('access denied on restricted model → DEFAULT_MODEL + sovereign-tier-1 preserved', async () => {
    mockedCheckModelAccess.mockResolvedValue(false);
    const sel = await selectAutoModel({ userId: 'u1', hasImages: false, prompt: 'v', piiDetected: true });
    expect(sel.modelId).toBe(DEFAULT_MODEL);
    expect(sel.reasonCode).toBe('auto-access-denied');
    expect(sel.flags).toContain('auto-access-denied');
    expect(sel.flags).toContain('sovereign-tier-1');
  });

  it('restricted requests use TIER1_MODEL_ID when configured', async () => {
    const routing = config.routing as { tier1ModelId?: string };
    const prev = routing.tier1ModelId;
    (routing as { tier1ModelId: string }).tier1ModelId = 'qwen.qwen3-32b-v1:0';
    try {
      const sel = await selectAutoModel({ userId: 'u1', hasImages: false, prompt: 'u', piiDetected: true });
      expect(sel.modelId).toBe('qwen.qwen3-32b-v1:0');
    } finally {
      (routing as { tier1ModelId: string }).tier1ModelId = prev;
    }
  });
});

describe('routeRequest — sovereignty tier surfacing', () => {
  beforeEach(() => {
    mockedCheckModelAccess.mockReset().mockResolvedValue(true);
    mockedGetRestrictedTerms.mockReset().mockResolvedValue([]);
    mockedGetDefaultTier3Model.mockReset().mockResolvedValue(null);
    gateway.enabled = false;
  });

  it('auto: fixed model, raw prompt, no contract, fallback skill (Tahap 1)', async () => {
    const d = await routeRequest(makeInput());
    expect(d.routingState).toBe('auto');
    expect(d.executedModelId).toBe(config.routing.autoModelId);
    expect(d.routingReasonCode).toBe('auto-fixed-model');
    expect(d.refinedPrompt).toBe('test prompt');
    expect(d.complexityScore).toBe(0);
    expect(d.scoreBand).toBe('direct-answer');
    expect(d.skill).toBe('fallback');
    expect(d.manualOverrideApplied).toBe(false);
  });

  it('auto: piiDetected threads through → auto-tier-1 + sovereign-tier-1', async () => {
    const d = await routeRequest(makeInput({ piiDetected: true }));
    expect(d.routingReasonCode).toBe('auto-tier-1');
    expect(d.flags).toContain('sovereign-tier-1');
  });

  it('auto: candidate flag surfaces through routeRequest when gateway on', async () => {
    setGateway(true, 'MiniMax-M2.7-highspeed');
    const d = await routeRequest(makeInput());
    expect(d.routingReasonCode).toBe('auto-fixed-model');
    expect(d.flags).toContain('tier3-candidate');
  });

  it('auto: preserves the access-denied fallback through routeRequest', async () => {
    mockedCheckModelAccess.mockResolvedValue(false);
    const d = await routeRequest(makeInput({ userId: 'restricted' }));
    expect(d.executedModelId).toBe(DEFAULT_MODEL);
    expect(d.routingReasonCode).toBe('auto-access-denied');
    expect(d.flags).toContain('auto-access-denied');
  });

  it('auto: clean maskedDocumentText → normal auto-fixed-model + document modality (no doc PII force)', async () => {
    const d = await routeRequest(makeInput({ maskedDocumentText: 'isi dokumen bersih, tidak ada data sensitif' }));
    expect(d.routingReasonCode).toBe('auto-fixed-model');
    expect(d.flags).not.toContain('sovereign-tier-1');
    expect(d.modalityFlags).toMatchObject({ documentText: true, textOnly: false });
  });

  it('auto: maskedDocumentText hit on restricted lexicon → auto-tier-1 + sovereign-tier-1 (doc forces private)', async () => {
    mockedGetRestrictedTerms.mockResolvedValue(['rahasia bank']);
    const d = await routeRequest(makeInput({ maskedDocumentText: 'ringkas: angka RAHASIA BANK 2026' }));
    expect(d.routingReasonCode).toBe('auto-tier-1');
    expect(d.flags).toEqual(expect.arrayContaining(['sovereign-tier-1']));
  });

  it('manual: honors the user-selected model byte-for-byte', async () => {
    const d = await routeRequest(makeInput({
      routingState: 'manual',
      manualModelId: 'anthropic.claude-sonnet-5',
    }));
    expect(d.routingState).toBe('manual');
    expect(d.executedModelId).toBe('anthropic.claude-sonnet-5');
    expect(d.routingReasonCode).toBe('manual-override');
    expect(d.manualOverrideApplied).toBe(true);
    expect(d.refinedPrompt).toBe('test prompt');
    expect(mockedCheckModelAccess).not.toHaveBeenCalled();
  });

  it('passthrough: raw prompt, no routing, passthrough flag', async () => {
    const d = await routeRequest(makeInput({
      routingState: 'passthrough',
      manualModelId: 'qwen.qwen3-32b-v1:0',
    }));
    expect(d.routingState).toBe('passthrough');
    expect(d.executedModelId).toBe('qwen.qwen3-32b-v1:0');
    expect(d.passthrough).toBe(true);
    expect(d.routingReasonCode).toBe('passthrough');
    expect(d.refinedPrompt).toBe('test prompt');
    expect(d.flags).toContain('passthrough');
    expect(mockedCheckModelAccess).not.toHaveBeenCalled();
  });
});
