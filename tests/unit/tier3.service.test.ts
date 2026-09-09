/**
 * Tier-3 registry service tests. The database module is mocked (query + pool.connect).
 * The getDefault cache is exercised across a fake clock: each test starts 61s later than the
 * last so a previous test's cached value is always expired at test boundaries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/database.js', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  query: vi.fn(),
  closePool: vi.fn(),
}));

import { pool } from '../../src/config/database.js';
import { config } from '../../src/config/index.js';
import {
  isEnabled,
  listModels,
  setModels,
  getDefaultTier3Model,
} from '../../src/services/tier3.service.js';

const mockedPool = vi.mocked(pool);
const gateway = config.routing.externalTier3 as {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
};

let clock = 0;
let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(clock++ * 61_000);
  mockedPool.query.mockReset();
  mockedPool.connect.mockReset();
  client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }), release: vi.fn() };
  mockedPool.connect.mockResolvedValue(client as never);
  // Default: gateway off and unconfigured.
  gateway.enabled = false;
  gateway.baseUrl = '';
  gateway.apiKey = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isEnabled', () => {
  it('false when disabled by env even with url+key', () => {
    gateway.baseUrl = 'https://gw.example.com';
    gateway.apiKey = 'k';
    gateway.enabled = false;
    expect(isEnabled()).toBe(false);
  });

  it('false when enabled but base URL or key missing', () => {
    gateway.enabled = true;
    gateway.baseUrl = 'https://gw.example.com';
    gateway.apiKey = '';
    expect(isEnabled()).toBe(false);
    gateway.apiKey = 'k';
    gateway.baseUrl = '';
    expect(isEnabled()).toBe(false);
  });

  it('true only when enabled and both url+key present', () => {
    gateway.enabled = true;
    gateway.baseUrl = 'https://gw.example.com';
    gateway.apiKey = 'k';
    expect(isEnabled()).toBe(true);
  });
});

describe('listModels', () => {
  it('maps DB rows to registry rows', async () => {
    mockedPool.query.mockResolvedValueOnce({
      rows: [
        { model_id: 'MiniMax-M2.7-highspeed', is_default: true, enabled: true },
        { model_id: 'qwen3.7-flash-2026-07-15', is_default: false, enabled: true },
      ],
    });
    const models = await listModels();
    expect(models).toEqual([
      { modelId: 'MiniMax-M2.7-highspeed', isDefault: true, enabled: true },
      { modelId: 'qwen3.7-flash-2026-07-15', isDefault: false, enabled: true },
    ]);
  });
});

describe('setModels (transaction)', () => {
  it('upserts, deletes missing rows, sets the valid default, commits', async () => {
    await setModels(
      [{ modelId: 'a', enabled: true }, { modelId: 'b', enabled: false }],
      'a',
    );

    const sqls = client.query.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(sqls).toContain('DELETE FROM tier3_models WHERE NOT (model_id = ANY($1::text[]))');
    expect(sqls.filter((s) => s.includes('ON CONFLICT (model_id) DO UPDATE'))).toHaveLength(2); // one per model
    expect(sqls).toContain('UPDATE tier3_models SET is_default = (model_id = $1)');
    expect(client.query.mock.calls[1][1]).toEqual([['a', 'b']]);
    const defaultCall = client.query.mock.calls.find((c) => (c[0] as string).includes('is_default = (model_id'));
    expect(defaultCall?.[1]).toEqual(['a']);
    expect(client.release).toHaveBeenCalled();
  });

  it('clears all defaults when the requested default is not in the list', async () => {
    await setModels([{ modelId: 'c', enabled: true }], 'ghost');
    const sqls = client.query.mock.calls.map((c) => c[0] as string);
    expect(sqls).toContain('UPDATE tier3_models SET is_default = false');
    expect(sqls).not.toContain('UPDATE tier3_models SET is_default = (model_id = $1)');
  });

  it('does not promote a disabled model to default', async () => {
    await setModels([{ modelId: 'd', enabled: false }], 'd');
    const sqls = client.query.mock.calls.map((c) => c[0] as string);
    expect(sqls).toContain('UPDATE tier3_models SET is_default = false');
  });

  it('rolls back and releases on failure', async () => {
    client.query.mockRejectedValueOnce(new Error('deadlock'));
    await expect(setModels([{ modelId: 'a', enabled: true }], 'a')).rejects.toThrow('deadlock');
    const sqls = client.query.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('getDefaultTier3Model', () => {
  it('returns the first enabled row (default first, then model_id)', async () => {
    mockedPool.query.mockResolvedValueOnce({ rows: [{ model_id: 'MiniMax-M2.7-highspeed' }] });
    expect(await getDefaultTier3Model()).toBe('MiniMax-M2.7-highspeed');
    const sql = mockedPool.query.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY is_default DESC, model_id LIMIT 1');
    expect(sql).toContain('WHERE enabled');
  });

  it('returns null when no enabled model exists', async () => {
    mockedPool.query.mockResolvedValueOnce({ rows: [] });
    expect(await getDefaultTier3Model()).toBeNull();
  });

  it('caches the result within the TTL (single query for two calls)', async () => {
    mockedPool.query.mockResolvedValue({ rows: [{ model_id: 'x' }] });
    expect(await getDefaultTier3Model()).toBe('x');
    expect(await getDefaultTier3Model()).toBe('x');
    expect(mockedPool.query).toHaveBeenCalledTimes(1);
  });

  it('refetches after the cache expires', async () => {
    mockedPool.query.mockResolvedValueOnce({ rows: [{ model_id: 'old' }] });
    expect(await getDefaultTier3Model()).toBe('old');

    vi.setSystemTime(clock * 61_000 + 31_000); // advance past the 30s TTL within this test
    mockedPool.query.mockResolvedValueOnce({ rows: [{ model_id: 'new' }] });
    expect(await getDefaultTier3Model()).toBe('new');
    expect(mockedPool.query).toHaveBeenCalledTimes(2);
  });
});
