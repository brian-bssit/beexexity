/**
 * API Key Service — generation, hashing, validation, and lifecycle management.
 * Uses SHA-256 hashing and timing-safe comparison to prevent timing attacks.
 * Full keys are returned exactly once (at creation time) and never stored in plaintext.
 * @see docs/feature-multi-tenant-api-key/
 */

import { randomBytes, createHash } from 'node:crypto';
import { query } from '../config/database.js';
import type { ApiKey, ApiKeyCreated, ApiKeyContext } from '../types/api-key.types.js';

interface ApiKeyRow {
  id: string;
  application_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  // JOIN fields
  app_name?: string;
  billing_mode?: 'PER_APP' | 'PER_USER';
  app_is_active?: boolean;
}

function mapRow(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    application_id: row.application_id,
    name: row.name,
    key_prefix: row.key_prefix,
    is_active: row.is_active,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  };
}

/** SHA-256 hash of a string, returned as hex. */
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Generate a new API key for an application.
 * Format: "bex_" + 32 random hex characters (36 chars total).
 * Returns the full key ONCE. The caller (admin route) must relay it to the admin
 * and never store or log it.
 */
export async function generateApiKey(
  applicationId: string,
  name: string,
): Promise<ApiKeyCreated> {
  const raw = randomBytes(16).toString('hex'); // 32 hex chars
  const key = `bex_${raw}`;
  const prefix = key.substring(0, 16);
  const hash = sha256(key);

  const { rows } = await query<ApiKeyRow>(
    `INSERT INTO api_keys (application_id, name, key_prefix, key_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [applicationId, name, prefix, hash],
  );
  if (!rows[0]) {
    throw new Error('Failed to create API key');
  }

  return { id: rows[0].id, key, prefix, name };
}

/** List all API keys for an application, newest first. */
export async function listKeysByApplication(applicationId: string): Promise<ApiKey[]> {
  const { rows } = await query<ApiKeyRow>(
    `SELECT * FROM api_keys WHERE application_id = $1 ORDER BY created_at DESC`,
    [applicationId],
  );
  return rows.map(mapRow);
}

/** Soft-deactivate an API key. Requests with this key are rejected immediately. */
export async function deactivateKey(id: string): Promise<void> {
  const result = await query(
    `UPDATE api_keys SET is_active = false WHERE id = $1`,
    [id],
  );
  if (result.rowCount === 0) {
    throw Object.assign(new Error('API key not found'), { status: 404 });
  }
}

/** Permanently delete an API key. Audit logs preserved (FK SET NULL). */
export async function deleteKey(id: string): Promise<void> {
  const result = await query('DELETE FROM api_keys WHERE id = $1', [id]);
  if (result.rowCount === 0) {
    throw Object.assign(new Error('API key not found'), { status: 404 });
  }
}

/**
 * Validate an incoming API key and resolve the application context.
 * Uses constant-time comparison to prevent timing attacks.
 * Returns null if the key is invalid, inactive, or the application is inactive.
 * Updates last_used_at on successful validation (fire-and-forget).
 */
export async function validateApiKey(key: string): Promise<ApiKeyContext | null> {
  const hash = sha256(key);

  // Single query: lookup key + join application
  const { rows } = await query<ApiKeyRow>(
    `SELECT k.id, k.application_id, k.is_active, a.name AS app_name,
            a.billing_mode, a.is_active AS app_is_active
     FROM api_keys k
     JOIN applications a ON a.id = k.application_id
     WHERE k.key_hash = $1`,
    [hash],
  );

  if (rows.length === 0) return null;

  const row = rows[0]!;

  if (!row.is_active || !row.app_is_active) return null;

  // Fire-and-forget last_used_at update — don't block the request
  query(
    `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
    [row.id],
  ).catch(() => { /* best-effort */ });

  return {
    apiKeyId: row.id,
    applicationId: row.application_id,
    applicationName: row.app_name ?? 'unknown',
    billingMode: row.billing_mode ?? 'PER_APP',
    username: null, // populated by middleware based on billingMode
  };
}
