/**
 * Tier-3 service — admin-managed external model registry (OpenAI-compatible gateway).
 * Auto-only: selectAutoModel escalates to the enabled default model when the gateway is on.
 * Key/base URL come from env (config.externalTier3) — never stored in DB.
 * @see docs/features/sovereign-tier-router/
 */

import { pool } from '../config/database.js';
import { config } from '../config/index.js';

export interface Tier3ModelRow {
  modelId: string;
  isDefault: boolean;
  enabled: boolean;
}

export interface Tier3ModelInput {
  modelId: string;
  enabled: boolean;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
let defaultCache: { value: string | null; at: number } | null = null;

/** Gateway usable? Requires the env kill-switch AND a configured base URL + key. */
export function isEnabled(): boolean {
  return config.routing.externalTier3.enabled
    && !!(config.routing.externalTier3.baseUrl && config.routing.externalTier3.apiKey);
}

export async function listModels(): Promise<Tier3ModelRow[]> {
  const result = await pool.query<{ model_id: string; is_default: boolean; enabled: boolean }>(
    'SELECT model_id, is_default, enabled FROM tier3_models ORDER BY is_default DESC, model_id',
  );
  return result.rows.map((r) => ({ modelId: r.model_id, isDefault: r.is_default, enabled: r.enabled }));
}

/**
 * Replace the registry. Transaction: upsert the given list, delete rows no longer listed,
 * clear all defaults, then set exactly one (the requested default if valid & enabled, else none).
 */
export async function setModels(models: Tier3ModelInput[], defaultId?: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = models.map((m) => m.modelId);
    await client.query('DELETE FROM tier3_models WHERE NOT (model_id = ANY($1::text[]))', [ids]);
    for (const m of models) {
      await client.query(
        `INSERT INTO tier3_models (model_id, enabled, is_default) VALUES ($1, $2, false)
         ON CONFLICT (model_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
        [m.modelId, m.enabled],
      );
    }
    const defaultValid = models.some((m) => m.modelId === defaultId && m.enabled);
    if (defaultValid) {
      await client.query('UPDATE tier3_models SET is_default = (model_id = $1)', [defaultId]);
    } else {
      await client.query('UPDATE tier3_models SET is_default = false');
    }
    await client.query('COMMIT');
    defaultCache = null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Model used for auto T3 escalation: enabled default, else first enabled. Cached ~30s so the
 * routing hot path stays DB-light when the gateway is on. Null → no escalation (stay private).
 */
export async function getDefaultTier3Model(): Promise<string | null> {
  if (defaultCache && Date.now() - defaultCache.at < DEFAULT_CACHE_TTL_MS) {
    return defaultCache.value;
  }
  const result = await pool.query<{ model_id: string }>(
    `SELECT model_id FROM tier3_models WHERE enabled
     ORDER BY is_default DESC, model_id LIMIT 1`,
  );
  const value = result.rows[0]?.model_id ?? null;
  defaultCache = { value, at: Date.now() };
  return value;
}
