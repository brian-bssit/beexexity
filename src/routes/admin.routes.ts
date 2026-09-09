import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { forcePasswordResetMiddleware } from '../middleware/password-reset.middleware.js';
import { adminMiddleware } from '../middleware/admin.middleware.js';
import { createUser, updateUser, upsertUser } from '../services/auth.service.js';
import { getCostReport } from '../services/cost-reporting.service.js';
import { configService } from '../services/config.service.js';
import { ALLOWED_MODELS } from '../types/inference.types.js';
import { query } from '../config/database.js';
import { TokenPayload } from '../types/auth.types.js';
import { ErrorResponse } from '../types/error.types.js';
import { config } from '../config/index.js';
import { listModels as listTier3Models, setModels as setTier3Models, isEnabled as isTier3Enabled } from '../services/tier3.service.js';
import { listTerms, addTerm, deleteTerm } from '../services/restricted-terms.service.js';

/**
 * Admin routes — user management endpoints restricted to admin role.
 * @see Requirements 2.1, 2.2, 2.3, 2.4
 */
const router = Router();

// Apply auth + admin guard to all admin routes
router.use(authMiddleware);
router.use(forcePasswordResetMiddleware);
router.use(adminMiddleware);

/**
 * POST /api/v1/admin/users
 * Register a new user in the Whitelist_DB.
 * Returns 201 with created user profile, 409 on duplicate username.
 */
router.post('/users', async (req: Request, res: Response): Promise<void> => {
  const { username, password, role, displayName, groupName } = req.body;

  // Validate required fields
  if (!username || !password || !role || !displayName) {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'username, password, role, and displayName are required',
    };
    res.status(400).json(error);
    return;
  }

  // Validate field types
  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    typeof role !== 'string' ||
    typeof displayName !== 'string'
  ) {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'username, password, role, and displayName must be strings',
    };
    res.status(400).json(error);
    return;
  }
  if (groupName !== undefined && typeof groupName !== 'string') {
    const error: ErrorResponse = { error: 'VALIDATION_ERROR', message: 'groupName must be a string' };
    res.status(400).json(error);
    return;
  }

  // Validate role value
  if (role !== 'admin' && role !== 'user') {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'role must be either "admin" or "user"',
    };
    res.status(400).json(error);
    return;
  }

  try {
    const admin = req.user as TokenPayload;
    const userProfile = await createUser(admin, { username, password, role, displayName, groupName });
    res.status(201).json(userProfile);
  } catch (err: unknown) {
    if (err instanceof Error && (err as Error & { statusCode?: number }).statusCode === 409) {
      const error: ErrorResponse = {
        error: 'USERNAME_EXISTS',
        message: 'Username already taken',
      };
      res.status(409).json(error);
      return;
    }
    const error: ErrorResponse = {
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    };
    res.status(500).json(error);
  }
});

/**
 * PUT /api/v1/admin/users/:username
 * Update an existing user's profile fields (role, displayName, password).
 * Returns 200 with updated user profile, 404 if user not found.
 */
router.put('/users/:username', async (req: Request, res: Response): Promise<void> => {
  const username = req.params.username as string;
  const { role, displayName, groupName, password, forcePasswordReset } = req.body;

  // At least one updatable field must be provided
  if (role === undefined && displayName === undefined && groupName === undefined && password === undefined && forcePasswordReset === undefined) {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'At least one field must be provided for update',
    };
    res.status(400).json(error);
    return;
  }

  // Validate role if provided
  if (role !== undefined) {
    if (typeof role !== 'string' || (role !== 'admin' && role !== 'user')) {
      const error: ErrorResponse = {
        error: 'VALIDATION_ERROR',
        message: 'role must be either "admin" or "user"',
      };
      res.status(400).json(error);
      return;
    }
  }

  // Validate displayName if provided
  if (displayName !== undefined && typeof displayName !== 'string') {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'displayName must be a string',
    };
    res.status(400).json(error);
    return;
  }

  // Validate groupName if provided
  if (groupName !== undefined && typeof groupName !== 'string') {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'groupName must be a string',
    };
    res.status(400).json(error);
    return;
  }

  // Validate password if provided
  if (password !== undefined && (typeof password !== 'string' || password.length < 6)) {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'password must be a string with at least 6 characters',
    };
    res.status(400).json(error);
    return;
  }

  try {
    const admin = req.user as TokenPayload;
    const userProfile = await updateUser(admin, username, { role, displayName, groupName, password, forcePasswordReset });
    res.status(200).json(userProfile);
  } catch (err: unknown) {
    if (err instanceof Error && (err as Error & { statusCode?: number }).statusCode === 404) {
      const error: ErrorResponse = {
        error: 'USER_NOT_FOUND',
        message: 'User not found',
      };
      res.status(404).json(error);
      return;
    }
    // Unexpected error — return 500 without exposing internals
    const error: ErrorResponse = {
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    };
    res.status(500).json(error);
  }
});

/**
 * POST /api/v1/admin/users/bulk
 *
 * Bulk upsert users. Each entry is upserted (create if missing, update if exists).
 * Processes all entries and returns per-item results with errors.
 * Validation fails fast — rejects the entire batch if the payload is invalid.
 */
router.post('/users/bulk', async (req: Request, res: Response): Promise<void> => {
  const entries = req.body;

  if (!Array.isArray(entries) || entries.length === 0) {
    const error: ErrorResponse = { error: 'VALIDATION_ERROR', message: 'Request body must be a non-empty JSON array' };
    res.status(400).json(error);
    return;
  }

  if (entries.length > 1000) {
    const error: ErrorResponse = { error: 'VALIDATION_ERROR', message: 'Maximum 1000 users per bulk upload' };
    res.status(400).json(error);
    return;
  }

  // Validate each entry schema
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object') {
      const error: ErrorResponse = { error: 'VALIDATION_ERROR', message: `Entry ${i} must be an object` };
      res.status(400).json(error);
      return;
    }
    if (!entry.username || typeof entry.username !== 'string') {
      const error: ErrorResponse = { error: 'VALIDATION_ERROR', message: `Entry ${i}: username is required` };
      res.status(400).json(error);
      return;
    }
    if (!entry.role || (entry.role !== 'admin' && entry.role !== 'user')) {
      const error: ErrorResponse = { error: 'VALIDATION_ERROR', message: `Entry ${i}: role must be "admin" or "user"` };
      res.status(400).json(error);
      return;
    }
    if (!entry.password || typeof entry.password !== 'string' || entry.password.length < 6) {
      const error: ErrorResponse = { error: 'VALIDATION_ERROR', message: `Entry ${i}: password must be at least 6 characters` };
      res.status(400).json(error);
      return;
    }
    if (entry.forcePasswordReset !== undefined && typeof entry.forcePasswordReset !== 'boolean') {
      const error: ErrorResponse = { error: 'VALIDATION_ERROR', message: `Entry ${i}: forcePasswordReset must be boolean` };
      res.status(400).json(error);
      return;
    }
    if (entry.displayName !== undefined && typeof entry.displayName !== 'string') {
      const error: ErrorResponse = { error: 'VALIDATION_ERROR', message: `Entry ${i}: displayName must be a string` };
      res.status(400).json(error);
      return;
    }
  }

  const results: Array<{ username: string; action: string; success: boolean; error?: string }> = [];

  // Process sequentially (not parallel) to avoid DB write contention
  for (const entry of entries) {
    try {
      const { action } = await upsertUser({
        username: entry.username,
        displayName: entry.displayName || entry.username,
        groupName: entry.groupName || undefined,
        role: entry.role,
        password: entry.password,
        forcePasswordReset: entry.forcePasswordReset ?? true,
      });
      results.push({ username: entry.username, action, success: true });
    } catch (err: unknown) {
      results.push({
        username: entry.username,
        action: 'skipped',
        success: false,
        error: (err as Error).message,
      });
    }
  }

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  res.status(200).json({ total: entries.length, successful, failed, results });
});

/**
 * GET /api/v1/admin/usage/cost
 *
 * Returns a paginated per-user cost report aggregated from audit_logs.
 * Cost is computed from per-request pricing snapshots stored at inference time.
 *
 * Query params:
 *   - from     (ISO date, optional)  Earliest timestamp to include (inclusive)
 *   - to       (ISO date, optional)  Latest date to include (inclusive — full day)
 *   - page     (number, default 1)
 *   - pageSize (number, default 20, max 100)
 *
 * Response: CostReportResponse
 */
router.get('/usage/cost', async (req: Request, res: Response): Promise<void> => {
  const from = typeof req.query.from === 'string' && req.query.from.trim()
    ? req.query.from.trim() : undefined;
  const to = typeof req.query.to === 'string' && req.query.to.trim()
    ? req.query.to.trim() : undefined;

  if (from && isNaN(Date.parse(from))) {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'Invalid "from" date format. Use ISO 8601 (e.g., 2026-06-01).',
    };
    res.status(400).json(error);
    return;
  }
  if (to && isNaN(Date.parse(to))) {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'Invalid "to" date format. Use ISO 8601 (e.g., 2026-06-01).',
    };
    res.status(400).json(error);
    return;
  }

  const page = Math.max(1, parseInt(String(req.query.page ?? ''), 10) || 1);
  const rawPageSize = parseInt(String(req.query.pageSize ?? ''), 10) || 20;
  const pageSize = Math.min(100, Math.max(1, rawPageSize));

  const applicationId = typeof req.query.applicationId === 'string' && req.query.applicationId.trim()
    ? req.query.applicationId.trim() : undefined;
  const apiKeyId = typeof req.query.apiKeyId === 'string' && req.query.apiKeyId.trim()
    ? req.query.apiKeyId.trim() : undefined;
  const username = typeof req.query.username === 'string' && req.query.username.trim()
    ? req.query.username.trim() : undefined;

  try {
    const report = await getCostReport(from, to, page, pageSize, applicationId, apiKeyId, username);
    res.status(200).json(report);
  } catch (err: unknown) {
    console.error('[admin] Cost report failed:', (err as Error).message);
    const error: ErrorResponse = {
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    };
    res.status(500).json(error);
  }
});

// ── Model Access Management ──────────────────────────────────────────────

/**
 * GET /api/v1/admin/model-access
 * Returns all models with their access lists. Models with no access rows are public.
 */
router.get('/model-access', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await Promise.all(
      ALLOWED_MODELS.map(async (modelId) => {
        const { rows } = await query<{ username: string; granted_at: string }>(
          `SELECT uma.username, uma.granted_at
           FROM user_model_access uma
           WHERE uma.model_id = $1
           ORDER BY uma.granted_at`,
          [modelId],
        );
        return {
          modelId,
          isPrivate: rows.length > 0,
          users: rows.map((r) => ({ username: r.username, grantedAt: r.granted_at })),
        };
      }),
    );
    res.status(200).json({ models: result });
  } catch (err: unknown) {
    console.error('[admin] Model access list failed:', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load model access' });
  }
});

/**
 * PUT /api/v1/admin/model-access/:modelId
 * Replace the whitelist for a model. Body: { usernames: string[] }
 * Empty array = make model public.
 */
router.put('/model-access/:modelId', async (req: Request, res: Response): Promise<void> => {
  const { modelId } = req.params;
  const { usernames } = req.body as { usernames?: string[] };

  if (!ALLOWED_MODELS.includes(modelId as typeof ALLOWED_MODELS[number])) {
    res.status(400).json({ error: 'INVALID_MODEL', message: 'Model not found' });
    return;
  }

  if (!Array.isArray(usernames)) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'usernames must be an array' });
    return;
  }

  try {
    // Resolve usernames → user records
    const { rows: users } = await query<{ id: string; username: string }>(
      `SELECT id, username FROM users WHERE username = ANY($1)`,
      [usernames],
    );

    // Warn about unknown usernames
    const found = new Set(users.map((u) => u.username));
    const unknown = usernames.filter((u) => !found.has(u));

    // Replace whitelist
    await query('DELETE FROM user_model_access WHERE model_id = $1', [modelId]);

    if (users.length > 0) {
      const values = users.map((u) => [u.id, modelId, u.username, req.user!.sub]);
      const placeholders = values
        .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
        .join(', ');
      const flat = values.flat();
      await query(
        `INSERT INTO user_model_access (user_id, model_id, username, granted_by) VALUES ${placeholders}`,
        flat,
      );
    }

    // Return updated list
    const updated = await query<{ username: string; granted_at: string }>(
      `SELECT uma.username, uma.granted_at
       FROM user_model_access uma
       WHERE uma.model_id = $1
       ORDER BY uma.granted_at`,
      [modelId],
    );

    const response: Record<string, unknown> = {
      modelId,
      isPrivate: updated.rows.length > 0,
      users: updated.rows.map((r) => ({ username: r.username, grantedAt: r.granted_at })),
    };
    if (unknown.length > 0) {
      response.unknownUsernames = unknown;
    }
    res.status(200).json(response);
  } catch (err: unknown) {
    console.error('[admin] Model access update failed:', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update model access' });
  }
});

/**
 * GET /api/v1/admin/config
 * Return current app configuration values.
 */
router.get('/config', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query<{ key: string; value: string }>('SELECT key, value FROM app_config');
    const config: Record<string, unknown> = {};
    for (const row of result.rows) {
      try { config[row.key] = JSON.parse(row.value); } catch { config[row.key] = row.value; }
    }
    res.json(config);
  } catch {
    res.status(500).json({ error: 'FAILED_TO_LOAD_CONFIG', message: 'Failed to load configuration' });
  }
});

/**
 * PUT /api/v1/admin/config
 * Update app configuration values.
 */
router.put('/config', async (req: Request, res: Response): Promise<void> => {
  try {
    const { passthroughMode } = req.body;

    if (passthroughMode !== undefined) {
      if (typeof passthroughMode !== 'boolean') {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'passthroughMode must be a boolean' });
        return;
      }
      await configService.setPassthroughMode(passthroughMode);
    }

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'FAILED_TO_UPDATE_CONFIG', message: 'Failed to update configuration' });
  }
});

/**
 * GET /api/v1/admin/env
 * Effective runtime values of boot-time environment knobs (env-only secrets are
 * never returned). Readable/overridable at runtime via PUT — env file untouched.
 */
router.get('/env', (_req: Request, res: Response): void => {
  res.json({
    knowledgeMinScore: config.knowledge.minRelevanceScore,
    routingMetadataEnabled: config.routing.metadataEnabled,
    tier3Enabled: config.routing.externalTier3.enabled,
  });
});

/**
 * PUT /api/v1/admin/env
 * Apply runtime overrides for env-driven knobs. Mutates the live config singleton
 * (consumers read these values per-request) — does not write .env, resets on
 * restart. KNOWLEDGE_MIN_SCORE is the primary backtesting knob.
 */
router.put('/env', (req: Request, res: Response): void => {
  const { knowledgeMinScore, routingMetadataEnabled, tier3Enabled } = req.body ?? {};
  if (knowledgeMinScore !== undefined) {
    if (typeof knowledgeMinScore !== 'number' || !Number.isFinite(knowledgeMinScore) || knowledgeMinScore < 0 || knowledgeMinScore > 1) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'knowledgeMinScore must be a number in [0, 1]' });
      return;
    }
    (config.knowledge as { minRelevanceScore: number }).minRelevanceScore = knowledgeMinScore;
  }
  const routing = config.routing as { metadataEnabled: boolean; externalTier3: { enabled: boolean } };
  if (routingMetadataEnabled !== undefined) {
    if (typeof routingMetadataEnabled !== 'boolean') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'routingMetadataEnabled must be a boolean' });
      return;
    }
    routing.metadataEnabled = routingMetadataEnabled;
  }
  if (tier3Enabled !== undefined) {
    if (typeof tier3Enabled !== 'boolean') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'tier3Enabled must be a boolean' });
      return;
    }
    routing.externalTier3.enabled = tier3Enabled;
  }
  res.json({ ok: true });
});

/**
 * GET /api/v1/admin/tier3
 * Read-only gateway status + admin-managed external model registry. API key never returned.
 */
router.get('/tier3', async (_req: Request, res: Response): Promise<void> => {
  try {
    const cfg = config.routing.externalTier3;
    let baseUrlHost = '';
    try { baseUrlHost = cfg.baseUrl ? new URL(cfg.baseUrl).host : ''; } catch { /* keep empty */ }
    const models = await listTier3Models();
    res.json({
      enabled: cfg.enabled,
      gatewayReady: isTier3Enabled(),
      baseUrlHost,
      apiKeySet: !!cfg.apiKey,
      models,
      defaultModel: models.find((m) => m.isDefault)?.modelId ?? null,
    });
  } catch {
    res.status(500).json({ error: 'FAILED_TO_LOAD_TIER3', message: 'Failed to load Tier-3 configuration' });
  }
});

/**
 * PUT /api/v1/admin/tier3
 * Replace the external model registry (upsert list, delete missing, set single default).
 */
router.put('/tier3', async (req: Request, res: Response): Promise<void> => {
  const { models, defaultModel } = req.body;
  if (!Array.isArray(models) || models.some((m: unknown) =>
    !m || typeof m !== 'object'
    || typeof (m as { modelId?: unknown }).modelId !== 'string'
    || !((m as { modelId?: string }).modelId ?? '').trim()
    || typeof (m as { enabled?: unknown }).enabled !== 'boolean')) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'models must be [{ modelId: string, enabled: boolean }]' });
    return;
  }
  if (defaultModel !== undefined && typeof defaultModel !== 'string') {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'defaultModel must be a string' });
    return;
  }
  try {
    const cleaned = (models as Array<{ modelId: string; enabled: boolean }>)
      .map((m) => ({ modelId: m.modelId.trim().slice(0, 128), enabled: m.enabled }));
    await setTier3Models(cleaned, defaultModel);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'FAILED_TO_UPDATE_TIER3', message: 'Failed to update Tier-3 models' });
  }
});

/**
 * GET /api/v1/admin/restricted-terms
 * List the admin-managed restricted-word lexicon.
 */
router.get('/restricted-terms', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ terms: await listTerms() });
  } catch {
    res.status(500).json({ error: 'FAILED_TO_LOAD_TERMS', message: 'Failed to load restricted terms' });
  }
});

/**
 * POST /api/v1/admin/restricted-terms  body { term }
 * Add a restricted word. 400 invalid, 409 duplicate.
 */
router.post('/restricted-terms', async (req: Request, res: Response): Promise<void> => {
  const term = req.body?.term;
  if (typeof term !== 'string' || !term.trim()) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'term is required' });
    return;
  }
  try {
    const added = await addTerm(term);
    if (!added) {
      res.status(409).json({ error: 'DUPLICATE_TERM', message: `Term already exists: ${term.trim()}` });
      return;
    }
    res.status(201).json({ ok: true, term: term.trim() });
  } catch (error) {
    if (error instanceof Error && error.message.includes('1-128')) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: error.message });
      return;
    }
    res.status(500).json({ error: 'FAILED_TO_ADD_TERM', message: 'Failed to add restricted term' });
  }
});

/**
 * DELETE /api/v1/admin/restricted-terms/:term
 * Remove a restricted word. 404 if not present.
 */
router.delete('/restricted-terms/:term', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deleteTerm(String(req.params.term));
    if (!deleted) {
      res.status(404).json({ error: 'TERM_NOT_FOUND', message: 'Term not found' });
      return;
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'FAILED_TO_DELETE_TERM', message: 'Failed to delete restricted term' });
  }
});

export default router;
