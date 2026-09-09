/**
 * Restricted-terms lexicon service tests. Database mocked via the named `query` export.
 * Cache TTL is 60s — each test starts 61s after the last so prior cached terms expire at
 * test boundaries; in-test invalidation is asserted directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  pool: { query: vi.fn(), connect: vi.fn() },
  closePool: vi.fn(),
}));

import { query } from '../../src/config/database.js';
import {
  getRestrictedTerms,
  listTerms,
  addTerm,
  deleteTerm,
} from '../../src/services/restricted-terms.service.js';

const mockedQuery = vi.mocked(query);

let clock = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(clock++ * 61_000);
  mockedQuery.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getRestrictedTerms', () => {
  it('loads and caches terms for the TTL (single query across calls)', async () => {
    mockedQuery.mockResolvedValue({ rows: [{ term: 'confidential' }, { term: 'rahasia' }] }); // DB already ORDER BY term
    expect(await getRestrictedTerms()).toEqual(['confidential', 'rahasia']);
    expect(await getRestrictedTerms()).toEqual(['confidential', 'rahasia']);
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it('degrades to [] on DB failure and does not poison the cache', async () => {
    mockedQuery.mockRejectedValueOnce(new Error('db down'));
    expect(await getRestrictedTerms()).toEqual([]);

    mockedQuery.mockResolvedValue({ rows: [{ term: 'internal' }] });
    expect(await getRestrictedTerms()).toEqual(['internal']); // re-queried, not cached []
  });
});

describe('listTerms', () => {
  it('always hits the DB (uncached)', async () => {
    mockedQuery.mockResolvedValue({ rows: [{ term: 'x' }] });
    await listTerms();
    await listTerms();
    expect(mockedQuery).toHaveBeenCalledTimes(2);
  });
});

describe('addTerm', () => {
  it('inserts a trimmed term, returns true, and invalidates the cache', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ term: 'rahasia' }] }); // prime cache
    await getRestrictedTerms();

    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT succeeds
    expect(await addTerm('  rahasia bank  ')).toBe(true);
    expect(mockedQuery.mock.calls[1][1]).toEqual(['rahasia bank']); // trimmed before insert

    mockedQuery.mockResolvedValue({ rows: [{ term: 'rahasia' }, { term: 'rahasia bank' }] });
    expect(await getRestrictedTerms()).toEqual(['rahasia', 'rahasia bank']); // fresh, not stale
  });

  it('returns false for a duplicate without invalidating the cache', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ term: 'ada' }] }); // prime cache
    await getRestrictedTerms();

    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ON CONFLICT DO NOTHING
    expect(await addTerm('ada')).toBe(false);

    expect(await getRestrictedTerms()).toEqual(['ada']); // still served from cache
    expect(mockedQuery).toHaveBeenCalledTimes(2); // prime SELECT + INSERT only
  });

  it('rejects empty (after trim) and oversized terms', async () => {
    await expect(addTerm('   ')).rejects.toThrow('Term must be 1-128 characters');
    await expect(addTerm('x'.repeat(129))).rejects.toThrow('Term must be 1-128 characters');
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});

describe('deleteTerm', () => {
  it('deletes an existing term and invalidates the cache', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ term: 'hapus' }] });
    await getRestrictedTerms();

    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await deleteTerm('hapus')).toBe(true);
    expect(mockedQuery.mock.calls[1][1]).toEqual(['hapus']);

    mockedQuery.mockResolvedValue({ rows: [] });
    expect(await getRestrictedTerms()).toEqual([]); // cache cleared → fresh read
  });

  it('returns false when the term did not exist', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] }); // empty prime is still cached
    await getRestrictedTerms();

    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await deleteTerm('tidak-ada')).toBe(false);
    expect(mockedQuery).toHaveBeenCalledTimes(2); // prime SELECT + DELETE only (cache kept)
  });
});
