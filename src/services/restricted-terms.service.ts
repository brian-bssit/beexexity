/**
 * Restricted-terms service — admin-managed lexicon for the sovereignty classifier.
 * A case-insensitive substring hit on the masked prompt/doc text forces a request private.
 * Terms are cached briefly; admin writes invalidate the cache. DB failure degrades to [] —
 * inference is never blocked (PII masking remains the primary restricted signal).
 * @see docs/features/sovereign-tier-router/
 */

import { query } from '../config/database.js';

const CACHE_TTL_MS = 60_000;
let cache: { terms: string[]; at: number } | null = null;

async function loadTerms(): Promise<string[]> {
  const result = await query<{ term: string }>('SELECT term FROM restricted_terms ORDER BY term');
  return result.rows.map((r) => r.term);
}

/** Current restricted-word list (cached). Empty on DB failure → PII-only classification. */
export async function getRestrictedTerms(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.terms;
  }
  let terms: string[];
  try {
    terms = await loadTerms();
  } catch (error) {
    console.error('[restricted-terms] Failed to load terms, degrading to []:', (error as Error).message);
    return [];
  }
  cache = { terms, at: Date.now() };
  return terms;
}

/** Admin list view. */
export async function listTerms(): Promise<string[]> {
  return loadTerms();
}

/** Add a term. Returns false if it already exists. Throws on invalid length. */
export async function addTerm(term: string): Promise<boolean> {
  const clean = term.trim();
  if (clean.length < 1 || clean.length > 128) {
    throw new Error('Term must be 1-128 characters');
  }
  const result = await query('INSERT INTO restricted_terms (term) VALUES ($1) ON CONFLICT (term) DO NOTHING', [clean]);
  if (result.rowCount && result.rowCount > 0) {
    cache = null;
    return true;
  }
  return false;
}

/** Delete a term. Returns false if it did not exist. */
export async function deleteTerm(term: string): Promise<boolean> {
  const result = await query('DELETE FROM restricted_terms WHERE term = $1', [term]);
  if (result.rowCount && result.rowCount > 0) {
    cache = null;
    return true;
  }
  return false;
}
