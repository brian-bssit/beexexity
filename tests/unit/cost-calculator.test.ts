import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadPricingConfig,
  calculateRequestCost,
  SessionCostTracker,
} from '../../src/frontend/cost-display.js';
import type { PricingConfig } from '../../src/types/pricing.types.js';
import { resolve } from 'path';

const PRICING_CONFIG_PATH = resolve(
  import.meta.dirname,
  '../../src/frontend/pricing-config.json'
);

const TEST_CONFIG: PricingConfig = {
  currency: 'USD',
  lastUpdated: '2026-06-23',
  models: {
    'model-a': {
      modelId: 'model-a',
      displayName: 'Model A',
      inputPricePer1MTokens: 0.16,
      outputPricePer1MTokens: 0.62,
    },
    'model-b': {
      modelId: 'model-b',
      displayName: 'Model B',
      inputPricePer1MTokens: 0.60,
      outputPricePer1MTokens: 1.74,
    },
  },
};

describe('loadPricingConfig', () => {
  it('should load and parse the pricing config from the default path', () => {
    const config = loadPricingConfig(PRICING_CONFIG_PATH);
    expect(config).not.toBeNull();
    expect(config!.currency).toBe('USD');
    expect(config!.lastUpdated).toBe('2026-06-29');
    expect(Object.keys(config!.models)).toHaveLength(10);
  });

  it('should return null for a non-existent file path', () => {
    const config = loadPricingConfig('/non/existent/path.json');
    expect(config).toBeNull();
  });

  it('should return null for an invalid JSON file', () => {
    // Use a file that exists but isn't valid pricing JSON
    const config = loadPricingConfig(
      resolve(import.meta.dirname, '../../tsconfig.json')
    );
    expect(config).toBeNull();
  });
});

describe('calculateRequestCost', () => {
  it('should calculate cost using the formula: (inputTokens × inputRate + outputTokens × outputRate) / 1_000_000', () => {
    // model-a: input=0.16, output=0.62
    // 1000 input tokens, 500 output tokens
    // cost = (1000 * 0.16 + 500 * 0.62) / 1_000_000
    //      = (160 + 310) / 1_000_000
    //      = 470 / 1_000_000
    //      = 0.00047
    const cost = calculateRequestCost('model-a', 1000, 500, TEST_CONFIG);
    expect(cost).toBeCloseTo(0.00047, 8);
  });

  it('should return null when config is null (Pricing_Config unavailable)', () => {
    const cost = calculateRequestCost('model-a', 1000, 500, null);
    expect(cost).toBeNull();
  });

  it('should return null when model is not in the config', () => {
    const cost = calculateRequestCost('unknown-model', 1000, 500, TEST_CONFIG);
    expect(cost).toBeNull();
  });

  it('should return 0 cost when both token counts are 0', () => {
    const cost = calculateRequestCost('model-a', 0, 0, TEST_CONFIG);
    expect(cost).toBe(0);
  });

  it('should handle large token counts correctly', () => {
    // 1M input tokens at model-a rate: 1_000_000 * 0.16 / 1_000_000 = 0.16
    const cost = calculateRequestCost('model-a', 1_000_000, 0, TEST_CONFIG);
    expect(cost).toBeCloseTo(0.16, 8);
  });

  it('should handle output-only tokens', () => {
    // 1M output tokens at model-b rate: 1_000_000 * 1.74 / 1_000_000 = 1.74
    const cost = calculateRequestCost('model-b', 0, 1_000_000, TEST_CONFIG);
    expect(cost).toBeCloseTo(1.74, 8);
  });
});

describe('SessionCostTracker', () => {
  let tracker: SessionCostTracker;

  beforeEach(() => {
    tracker = new SessionCostTracker(TEST_CONFIG);
  });

  describe('basic tracking', () => {
    it('should start with empty state', () => {
      const state = tracker.getState();
      expect(state.requests).toHaveLength(0);
      expect(state.sessionTotal).toBe(0);
    });

    it('should track a single request', () => {
      const result = tracker.addRequest('model-a', 1000, 500);
      expect(result.modelId).toBe('model-a');
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.cost).toBeCloseTo(0.00047, 8);
    });

    it('should accumulate session total across multiple requests', () => {
      tracker.addRequest('model-a', 1000, 500); // 0.00047
      tracker.addRequest('model-a', 2000, 1000); // 0.00094

      expect(tracker.getSessionTotal()).toBeCloseTo(0.00141, 8);
      expect(tracker.getRequests()).toHaveLength(2);
    });
  });

  describe('model switching — additive accumulation', () => {
    it('should NOT recalculate past costs when switching models', () => {
      // Request 1: model-a, 1000 input, 500 output
      // cost = (1000 * 0.16 + 500 * 0.62) / 1_000_000 = 0.00047
      const req1 = tracker.addRequest('model-a', 1000, 500);

      // Request 2: model-b (different rates!), 1000 input, 500 output
      // cost = (1000 * 0.60 + 500 * 1.74) / 1_000_000 = 0.00147
      const req2 = tracker.addRequest('model-b', 1000, 500);

      // Session total = sum of individual costs at their own rates
      expect(req1.cost).toBeCloseTo(0.00047, 8);
      expect(req2.cost).toBeCloseTo(0.00147, 8);
      expect(tracker.getSessionTotal()).toBeCloseTo(0.00047 + 0.00147, 8);
    });

    it('should track each request with its own model rate independently', () => {
      tracker.addRequest('model-a', 5000, 3000);
      tracker.addRequest('model-b', 5000, 3000);
      tracker.addRequest('model-a', 5000, 3000);

      const requests = tracker.getRequests();
      expect(requests).toHaveLength(3);

      // model-a cost: (5000 * 0.16 + 3000 * 0.62) / 1_000_000 = 0.00266
      // model-b cost: (5000 * 0.60 + 3000 * 1.74) / 1_000_000 = 0.00822
      const modelACost = (5000 * 0.16 + 3000 * 0.62) / 1_000_000;
      const modelBCost = (5000 * 0.60 + 3000 * 1.74) / 1_000_000;

      expect(requests[0].cost).toBeCloseTo(modelACost, 8);
      expect(requests[1].cost).toBeCloseTo(modelBCost, 8);
      expect(requests[2].cost).toBeCloseTo(modelACost, 8);

      expect(tracker.getSessionTotal()).toBeCloseTo(
        modelACost + modelBCost + modelACost,
        8
      );
    });
  });

  describe('graceful degradation (missing Pricing_Config)', () => {
    let noPricingTracker: SessionCostTracker;

    beforeEach(() => {
      noPricingTracker = new SessionCostTracker(null);
    });

    it('should report pricing not available', () => {
      expect(noPricingTracker.hasPricingAvailable()).toBe(false);
    });

    it('should still track token counts with cost = 0', () => {
      const result = noPricingTracker.addRequest('model-a', 1000, 500);
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.cost).toBe(0);
    });

    it('should accumulate requests with zero cost', () => {
      noPricingTracker.addRequest('model-a', 1000, 500);
      noPricingTracker.addRequest('model-b', 2000, 1000);

      const state = noPricingTracker.getState();
      expect(state.requests).toHaveLength(2);
      expect(state.sessionTotal).toBe(0);
    });
  });

  describe('unknown model in config', () => {
    it('should track request with cost = 0 for unknown model', () => {
      const result = tracker.addRequest('unknown-model', 1000, 500);
      expect(result.cost).toBe(0);
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
    });

    it('should report model pricing unavailable for unknown model', () => {
      expect(tracker.hasModelPricing('unknown-model')).toBe(false);
      expect(tracker.hasModelPricing('model-a')).toBe(true);
    });
  });

  describe('reset', () => {
    it('should clear all state on reset', () => {
      tracker.addRequest('model-a', 1000, 500);
      tracker.addRequest('model-b', 2000, 1000);
      tracker.reset();

      const state = tracker.getState();
      expect(state.requests).toHaveLength(0);
      expect(state.sessionTotal).toBe(0);
    });
  });

  describe('getState returns a snapshot (immutability)', () => {
    it('should return a copy of requests array', () => {
      tracker.addRequest('model-a', 1000, 500);
      const state = tracker.getState();
      state.requests.push({
        modelId: 'fake',
        inputTokens: 0,
        outputTokens: 0,
        cost: 999,
      });

      // Internal state should not be affected
      expect(tracker.getRequests()).toHaveLength(1);
    });
  });
});
