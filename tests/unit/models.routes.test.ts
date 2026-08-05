import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';

// Mock auth middleware to pass through and attach user
vi.mock('../../src/middleware/auth.middleware.js', () => ({
  authMiddleware: (req: Request, _res: Response, next: () => void) => {
    (req as any).user = { sub: 'test-user-id', username: 'testuser' };
    next();
  },
}));

// Mock fs to control pricing config loading
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

// Mock database — no access rows = public model
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

import { readFileSync } from 'fs';
import { ALLOWED_MODELS, DEFAULT_MODEL } from '../../src/types/inference.types.js';

const mockPricingConfig = {
  currency: 'USD',
  lastUpdated: '2026-06-23',
  models: {
    'amazon.nova-lite-v1:0': {
      displayName: 'Amazon Nova 2 Lite',
      inputPricePer1MTokens: 0.06,
      outputPricePer1MTokens: 0.24,
    },
    'openai.gpt-oss-120b-1:0': {
      displayName: 'OpenAI GPT OSS 120B',
      inputPricePer1MTokens: 0.16,
      outputPricePer1MTokens: 0.62,
    },
    'qwen.qwen3-235b-a22b-2507-v1:0': {
      displayName: 'Qwen3 235B A22B',
      inputPricePer1MTokens: 0.23,
      outputPricePer1MTokens: 0.91,
    },
    'qwen.qwen3-32b-v1:0': {
      displayName: 'Qwen3 32B (Default)',
      inputPricePer1MTokens: 0.16,
      outputPricePer1MTokens: 0.62,
    },
    'anthropic.claude-sonnet-5': {
      displayName: 'Claude Sonnet 5',
      inputPricePer1MTokens: 2.00,
      outputPricePer1MTokens: 10.00,
    },
    'zai.glm-5': {
      displayName: 'GLM-5',
      inputPricePer1MTokens: 1.20,
      outputPricePer1MTokens: 3.84,
    },
    'deepseek.v3.2': {
      displayName: 'DeepSeek V3.2',
      inputPricePer1MTokens: 0.74,
      outputPricePer1MTokens: 2.22,
    },
  },
};

describe('GET /api/v1/models', () => {
  let mockRes: Partial<Response>;
  let jsonSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    jsonSpy = vi.fn();
    mockRes = {
      json: jsonSpy,
    };
  });

  it('should return all 4 allowed models with pricing info', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockPricingConfig));

    // Dynamically import after mocks are set up
    const { default: router } = await import('../../src/routes/models.routes.js');

    // Find the route handler (last middleware in the stack)
    const layer = router.stack.find(
      (l: { route?: { path: string; methods: { get?: boolean } } }) =>
        l.route?.path === '/' && l.route?.methods.get
    );
    expect(layer).toBeDefined();

    const handlers = layer!.route!.stack.map(
      (s: { handle: Function }) => s.handle
    );
    // The last handler is our route handler (after auth middleware)
    const routeHandler = handlers[handlers.length - 1];

    const mockReq = { user: { sub: 'test-user' } } as Request;
    await routeHandler(mockReq, mockRes as Response);

    expect(jsonSpy).toHaveBeenCalledOnce();
    const response = jsonSpy.mock.calls[0][0];

    // Should have 7 models
    expect(response.models).toHaveLength(7);

    // Should include all allowed models
    const modelIds = response.models.map((m: { modelId: string }) => m.modelId);
    for (const allowed of ALLOWED_MODELS) {
      expect(modelIds).toContain(allowed);
    }

    // Should mark default model
    expect(response.defaultModel).toBe(DEFAULT_MODEL);
    expect(response.currency).toBe('USD');

    // Default model should have isDefault: true
    const defaultModel = response.models.find(
      (m: { modelId: string }) => m.modelId === DEFAULT_MODEL
    );
    expect(defaultModel?.isDefault).toBe(true);

    // Non-default models should have isDefault: false
    const nonDefaults = response.models.filter(
      (m: { modelId: string }) => m.modelId !== DEFAULT_MODEL
    );
    for (const model of nonDefaults) {
      expect(model.isDefault).toBe(false);
    }
  });

  it('should include pricing info for each model', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockPricingConfig));

    const { default: router } = await import('../../src/routes/models.routes.js');

    const layer = router.stack.find(
      (l: { route?: { path: string; methods: { get?: boolean } } }) =>
        l.route?.path === '/' && l.route?.methods.get
    );
    const handlers = layer!.route!.stack.map(
      (s: { handle: Function }) => s.handle
    );
    const routeHandler = handlers[handlers.length - 1];

    const mockReq = { user: { sub: 'test-user' } } as Request;
    await routeHandler(mockReq, mockRes as Response);

    const response = jsonSpy.mock.calls[0][0];

    // Each model should have pricing info
    for (const model of response.models) {
      expect(model.pricing).toBeDefined();
      expect(model.pricing.inputPricePer1MTokens).toBeTypeOf('number');
      expect(model.pricing.outputPricePer1MTokens).toBeTypeOf('number');
    }

    // Verify specific pricing
    const qwen32b = response.models.find(
      (m: { modelId: string }) => m.modelId === 'qwen.qwen3-32b-v1:0'
    );
    expect(qwen32b.pricing.inputPricePer1MTokens).toBe(0.16);
    expect(qwen32b.pricing.outputPricePer1MTokens).toBe(0.62);
  });

  it('should include display names from pricing config', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockPricingConfig));

    const { default: router } = await import('../../src/routes/models.routes.js');

    const layer = router.stack.find(
      (l: { route?: { path: string; methods: { get?: boolean } } }) =>
        l.route?.path === '/' && l.route?.methods.get
    );
    const handlers = layer!.route!.stack.map(
      (s: { handle: Function }) => s.handle
    );
    const routeHandler = handlers[handlers.length - 1];

    const mockReq = { user: { sub: 'test-user' } } as Request;
    await routeHandler(mockReq, mockRes as Response);

    const response = jsonSpy.mock.calls[0][0];

    const openai = response.models.find(
      (m: { modelId: string }) => m.modelId === 'openai.gpt-oss-120b-1:0'
    );
    expect(openai.displayName).toBe('OpenAI GPT OSS 120B');

    const qwen32b = response.models.find(
      (m: { modelId: string }) => m.modelId === 'qwen.qwen3-32b-v1:0'
    );
    expect(qwen32b.displayName).toBe('Qwen3 32B (Default)');
  });

  it('should gracefully handle missing pricing config', async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT: file not found');
    });

    const { default: router } = await import('../../src/routes/models.routes.js');

    const layer = router.stack.find(
      (l: { route?: { path: string; methods: { get?: boolean } } }) =>
        l.route?.path === '/' && l.route?.methods.get
    );
    const handlers = layer!.route!.stack.map(
      (s: { handle: Function }) => s.handle
    );
    const routeHandler = handlers[handlers.length - 1];

    const mockReq = { user: { sub: 'test-user' } } as Request;
    await routeHandler(mockReq, mockRes as Response);

    const response = jsonSpy.mock.calls[0][0];

    // Should still return all models
    expect(response.models).toHaveLength(7);

    // Should fall back to modelId as displayName
    for (const model of response.models) {
      expect(model.displayName).toBe(model.modelId);
      expect(model.pricing).toBeUndefined();
    }

    // Currency should default to USD
    expect(response.currency).toBe('USD');
    expect(response.defaultModel).toBe(DEFAULT_MODEL);
  });
});
