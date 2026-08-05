import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/config/database.js';
import { getCostReport } from '../../src/services/cost-reporting.service.js';

const mockedQuery = vi.mocked(query);

/** Helper: a single valid audit row with pricing snapshot */
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'u1',
    username: 'alice',
    display_name: 'Alice',
    model_id: 'qwen.qwen3-32b-v1:0',
    input_tokens: '100',
    output_tokens: '50',
    request_count: '3',
    model_pricing_snapshot: { inputPricePer1MTokens: 0.16, outputPricePer1MTokens: 0.62 },
    ...overrides,
  };
}

describe('CostReportingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getCostReport()', () => {
    it('returns empty report when no audit_logs match', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] } as any);

      const result = await getCostReport(undefined, undefined, 1, 20);

      expect(result.users).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
      expect(result.grandTotal.estimatedCostUsd).toBeNull();
    });

    it('aggregates a single user with one model correctly', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] } as any);
      mockedQuery.mockResolvedValueOnce({ rows: [makeRow()] } as any);

      const result = await getCostReport();

      expect(result.users).toHaveLength(1);
      const u = result.users[0];
      expect(u.userId).toBe('u1');
      expect(u.username).toBe('alice');
      expect(u.displayName).toBe('Alice');
      expect(u.totalInputTokens).toBe(100);
      expect(u.totalOutputTokens).toBe(50);
      expect(u.requestCount).toBe(3);
      expect(u.breakdown).toHaveLength(1);
      // cost = (100 * 0.16 + 50 * 0.62) / 1e6 = (16 + 31) / 1e6 = 0.000047
      expect(u.estimatedCostUsd).toBeCloseTo(0.000047, 9);
      expect(result.grandTotal.estimatedCostUsd).toBeCloseTo(0.000047, 9);
    });

    it('aggregates multiple users with different models correctly', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] } as any);
      mockedQuery.mockResolvedValueOnce({
        rows: [
          makeRow(),
          makeRow({
            user_id: 'u2',
            username: 'bob',
            display_name: 'Bob',
            model_id: 'amazon.nova-lite-v1:0',
            input_tokens: '200',
            output_tokens: '100',
            request_count: '5',
            model_pricing_snapshot: { inputPricePer1MTokens: 0.06, outputPricePer1MTokens: 0.24 },
          }),
        ],
      } as any);

      const result = await getCostReport();

      expect(result.users).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.grandTotal.totalInputTokens).toBe(300);
      expect(result.grandTotal.totalOutputTokens).toBe(150);
      expect(result.grandTotal.requestCount).toBe(8);
    });

    it('handles same model with different pricing snapshots for one user', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] } as any);
      mockedQuery.mockResolvedValueOnce({
        rows: [
          makeRow(),
          makeRow({
            input_tokens: '50',
            output_tokens: '25',
            request_count: '1',
            model_pricing_snapshot: { inputPricePer1MTokens: 0.2, outputPricePer1MTokens: 0.8 },
          }),
        ],
      } as any);

      const result = await getCostReport();

      expect(result.users).toHaveLength(1);
      expect(result.users[0].breakdown).toHaveLength(2);
      expect(result.users[0].totalInputTokens).toBe(150);
      expect(result.users[0].totalOutputTokens).toBe(75);
      expect(result.users[0].requestCount).toBe(4);
    });

    it('sets estimatedCostUsd to null when pricing snapshot is missing', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] } as any);
      mockedQuery.mockResolvedValueOnce({
        rows: [makeRow({ model_pricing_snapshot: null })],
      } as any);

      const result = await getCostReport();

      expect(result.users[0].estimatedCostUsd).toBeNull();
      expect(result.users[0].breakdown[0].estimatedCostUsd).toBeNull();
      expect(result.grandTotal.estimatedCostUsd).toBeNull();
    });

    it('passes date filter params to the count query', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] } as any);

      await getCostReport('2026-06-01', '2026-06-30', 1, 20);

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('COUNT(DISTINCT'),
        ['2026-06-01', '2026-06-30', null, null, null],
      );
    });

    it('sets hasMore correctly when total exceeds page boundary', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ count: '25' }] } as any);
      mockedQuery.mockResolvedValueOnce({ rows: [makeRow()] } as any);

      const result = await getCostReport(undefined, undefined, 1, 20);

      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(25);
    });

    it('sets hasMore false when page covers all results', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ count: '15' }] } as any);
      mockedQuery.mockResolvedValueOnce({ rows: [makeRow()] } as any);

      const result = await getCostReport(undefined, undefined, 1, 20);

      expect(result.hasMore).toBe(false);
    });
  });
});
