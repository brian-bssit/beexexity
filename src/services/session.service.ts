import { query } from '../config/database.js';
import { config } from '../config/index.js';
import type { Session, StoredMessage, StorageFlags, SessionWithStats, SessionStats, ModelBreakdown } from '../types/session.types.js';

/**
 * Session Service — manages conversation session lifecycle and message CRUD.
 * Sessions are scoped to authenticated users and expire after a configurable period.
 * Expired sessions are detected at read time; no background sweep required.
 *
 * @see Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.4, 2.5, 2.6
 */

/**
 * Thrown when a session has passed its expires_at time.
 */
export class SessionExpiredError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} has expired`);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Thrown when a session is not found or does not belong to the requesting user.
 */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} not found`);
    this.name = 'SessionNotFoundError';
  }
}

/**
 * Database row shape for sessions table.
 */
interface SessionRow {
  id: string;
  user_id: string;
  status: 'active' | 'degraded' | 'inactive' | 'expired';
  turn_count: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  expires_at: string;
  internal_document_context?: string | null;
  internal_document_title?: string | null;
}

/**
 * Database row shape for messages table.
 */
interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  sanitized_content: string;
  created_at: string;
  storage_flags: StorageFlags;
}

/**
 * Map a database row to the Session domain type.
 */
function mapSessionRow(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    turnCount: row.turn_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    internalDocumentContext: row.internal_document_context ?? undefined,
    internalDocumentTitle: row.internal_document_title ?? undefined,
  };
}

/**
 * Map a database row to the StoredMessage domain type.
 */
function mapMessageRow(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    sanitizedContent: row.sanitized_content,
    createdAt: row.created_at,
    storageFlags: row.storage_flags,
  };
}

/**
 * Check whether a session has expired by comparing expires_at with the current time.
 */
export function isSessionExpired(session: Session): boolean {
  return new Date(session.expiresAt) <= new Date();
}

/**
 * Update last_activity_at and updated_at for a session.
 * Called after each message append to keep the session's activity timestamp fresh.
 */
export async function touchSession(sessionId: string): Promise<void> {
  await query(
    `UPDATE sessions SET last_activity_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [sessionId],
  );
}

/**
 * Persist the PII-masked text of a Google Workspace document fetched in this session.
 * Sticky: every later turn reads it back as internal context, so the conversation can
 * never escalate to the external Tier-3 gateway and follow-ups still see the document.
 * `text` must already be masked — this column is the same posture as stored messages.
 */
export async function setInternalDocumentContext(
  sessionId: string,
  text: string,
  title?: string,
): Promise<void> {
  try {
    await query(
      `UPDATE sessions SET internal_document_context = $2, internal_document_title = $3 WHERE id = $1`,
      [sessionId, text, title ?? null],
    );
  } catch (err: unknown) {
    // Non-fatal: the current turn still has the document in hand. Losing the sticky
    // context degrades later turns (they may escalate) — surface it in logs.
    console.error('[session] Failed to persist internal document context:', (err as Error).message);
  }
}

/**
 * Retrieve or create a session for the given user.
 *
 * If sessionId is provided and refers to an active, non-expired session owned
 * by the user, that session is returned. Otherwise a new active session is created
 * with expiresAt = now + config.session.expiryHours.
 *
 * Invalid, expired, or foreign sessionIds are silently ignored and a new session
 * is created instead — this follows the design's graceful-degradation principle.
 */
export async function getOrCreateSession(userId: string, sessionId?: string): Promise<Session> {
  // Attempt to retrieve the provided session if an ID was given
  if (sessionId) {
    const result = await query<SessionRow>(
      `SELECT id, user_id, status, turn_count, created_at, updated_at, last_activity_at, expires_at, internal_document_context, internal_document_title
       FROM sessions WHERE id = $1`,
      [sessionId],
    );

    const row = result.rows[0];
    if (row) {
      const session = mapSessionRow(row);

      // Validate ownership, active status, and expiry
      if (session.userId === userId && session.status === 'active' && !isSessionExpired(session)) {
        return session;
      }
    }
  }

  // Create a new session with expiry = now + expiryHours
  const expiryHours = config.session.expiryHours;
  const createResult = await query<SessionRow>(
    `INSERT INTO sessions (user_id, status, expires_at)
     VALUES ($1, 'active', NOW() + INTERVAL '1 hour' * $2)
     RETURNING id, user_id, status, turn_count, created_at, updated_at, last_activity_at, expires_at, internal_document_context, internal_document_title`,
    [userId, expiryHours],
  );

  return mapSessionRow(createResult.rows[0]);
}

/**
 * Get the most recent active session for a user.
 * Returns null if no active (non-expired) session exists.
 */
export async function getActiveSession(userId: string): Promise<Session | null> {
  const result = await query<SessionRow>(
    `SELECT id, user_id, status, turn_count, created_at, updated_at, last_activity_at, expires_at, internal_document_context, internal_document_title
     FROM sessions
     WHERE user_id = $1 AND status = 'active'
     ORDER BY last_activity_at DESC
     LIMIT 1`,
    [userId],
  );

  const row = result.rows[0];
  if (!row) return null;

  const session = mapSessionRow(row);

  // Check expiry at read time
  if (isSessionExpired(session)) {
    return null;
  }

  return session;
}

/**
 * Retrieve messages for a session ordered by created_at ASC, tie-broken by id ASC.
 * Optionally limits the number of messages returned.
 */
export async function getSessionMessages(sessionId: string, limit?: number): Promise<StoredMessage[]> {
  let sql = `SELECT id, session_id, role, sanitized_content, created_at, storage_flags
             FROM messages
             WHERE session_id = $1
             ORDER BY created_at ASC, id ASC`;
  const params: unknown[] = [sessionId];

  if (limit !== undefined && limit > 0) {
    sql += ` LIMIT $2`;
    params.push(limit);
  }

  const result = await query<MessageRow>(sql, params);
  return result.rows.map(mapMessageRow);
}

/**
 * Store a new message in the session and touch the session's activity timestamp.
 * Returns the stored message record.
 *
 * If persistence fails, the error is propagated so the caller can handle it
 * according to the graceful-degradation policy (log and flag session as partially persisted).
 */
export async function storeMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  flags: StorageFlags,
): Promise<StoredMessage> {
  const result = await query<MessageRow>(
    `INSERT INTO messages (session_id, role, sanitized_content, storage_flags)
     VALUES ($1, $2, $3, $4)
     RETURNING id, session_id, role, sanitized_content, created_at, storage_flags`,
    [sessionId, role, content, JSON.stringify(flags)],
  );

  // Update session activity timestamps
  await touchSession(sessionId);

  return mapMessageRow(result.rows[0]);
}

/**
 * Transition a session to 'degraded' state.
 * Called when assistant message persistence fails.
 * This operation is idempotent — no error if the session is already degraded.
 *
 * @see Requirements 1.3, 1.4
 */
export async function transitionToDegraded(sessionId: string): Promise<void> {
  await query(
    `UPDATE sessions SET status = 'degraded', updated_at = NOW() WHERE id = $1`,
    [sessionId],
  );
}

/**
 * Increment the turn_count for a session after a complete turn.
 * Called only after both user and assistant messages are successfully persisted.
 */
export async function incrementTurnCount(sessionId: string): Promise<void> {
  await query(
    `UPDATE sessions SET turn_count = turn_count + 1, updated_at = NOW() WHERE id = $1`,
    [sessionId],
  );
}

/**
 * Mark a session as inactive. Used when the user explicitly starts a new chat
 * or when the reset endpoint is called.
 * This operation is idempotent — calling it on an already-inactive session is safe.
 */
export async function markSessionInactive(sessionId: string): Promise<void> {
  await query(
    `UPDATE sessions SET status = 'inactive', updated_at = NOW() WHERE id = $1`,
    [sessionId],
  );
}

/**
 * Fetch a session by ID, verifying ownership. Returns null if not found or wrong user.
 * Does NOT throw on expired status — callers decide whether expiry matters.
 */
export async function getSessionById(userId: string, sessionId: string): Promise<Session | null> {
  const result = await query<SessionRow>(
    `SELECT id, user_id, status, turn_count, created_at, updated_at, last_activity_at, expires_at, internal_document_context, internal_document_title
     FROM sessions WHERE id = $1`,
    [sessionId],
  );

  const row = result.rows[0];
  if (!row || row.user_id !== userId) return null;

  return mapSessionRow(row);
}

/**
 * Sweep expired sessions for a user, transitioning them to 'expired' status.
 * Called before listing sessions so the list reflects current state.
 * This operation is idempotent — running it multiple times is safe.
 */
export async function sweepExpiredSessions(userId: string): Promise<void> {
  await query(
    `UPDATE sessions SET status = 'expired', updated_at = NOW()
     WHERE user_id = $1 AND expires_at <= NOW() AND status != 'expired'`,
    [userId],
  );
}

/**
 * Get session with state validation — rejects expired sessions.
 * Returns the session or throws SessionExpiredError / SessionNotFoundError.
 *
 * If no sessionId is provided, delegates to getOrCreateSession (which always
 * returns a valid active session).
 *
 * If sessionId is provided:
 * - Fetches the session from DB
 * - Throws SessionNotFoundError if the session doesn't exist or belongs to a different user
 * - Throws SessionExpiredError if expires_at is in the past
 * - Allows both 'active' and 'degraded' sessions to proceed
 *
 * @see Requirements 1.6, 2.1
 */
export async function getValidatedSession(
  userId: string,
  sessionId?: string,
): Promise<Session> {
  // No sessionId provided — delegate to existing getOrCreateSession
  if (!sessionId) {
    return getOrCreateSession(userId);
  }

  // Fetch the session by ID
  const result = await query<SessionRow>(
    `SELECT id, user_id, status, turn_count, created_at, updated_at, last_activity_at, expires_at, internal_document_context, internal_document_title
     FROM sessions WHERE id = $1`,
    [sessionId],
  );

  const row = result.rows[0];

  // Not found or belongs to a different user → SessionNotFoundError
  if (!row || row.user_id !== userId) {
    throw new SessionNotFoundError(sessionId);
  }

  const session = mapSessionRow(row);

  // Check expiry — reject if expires_at is in the past
  if (isSessionExpired(session)) {
    throw new SessionExpiredError(sessionId);
  }

  // Allow both 'active' and 'degraded' sessions to proceed
  return session;
}

// ── Chat History Sidebar Functions ──

/**
 * Database row shape for the session list query (includes lateral join columns).
 */
interface SessionListRow extends SessionRow {
  preview: string | null;
  total_input_tokens: string | null;
  total_output_tokens: string | null;
  request_count: string | null;
  estimated_cost: string | null;
}

/**
 * List sessions for a user with pagination, preview text, and aggregated token stats.
 * Runs an expiry sweep before fetching to keep the list accurate.
 *
 * @see Requirements R5
 */
export async function listUserSessions(
  userId: string,
  page: number,
  pageSize: number,
): Promise<{ sessions: SessionWithStats[]; total: number }> {
  // 1. Sweep expired sessions first
  await sweepExpiredSessions(userId);

  // 2. Count total sessions for this user
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*)::integer AS count FROM sessions WHERE user_id = $1`,
    [userId],
  );
  const total = parseInt(countResult.rows[0].count, 10);

  // 3. Fetch page with lateral joins for preview + stats
  const offset = (page - 1) * pageSize;
  const result = await query<SessionListRow>(
    `SELECT
       s.id, s.user_id, s.status, s.turn_count,
       s.created_at, s.updated_at, s.last_activity_at, s.expires_at,
       COALESCE(st.total_input_tokens, '0')  AS total_input_tokens,
       COALESCE(st.total_output_tokens, '0') AS total_output_tokens,
       COALESCE(st.request_count, '0')       AS request_count,
       COALESCE(al.session_context, rt.routing_context, rt.routing_intent, am.sanitized_content, '') AS preview
     FROM sessions s
     LEFT JOIN LATERAL (
       SELECT session_context, routing_context, routing_intent
       FROM audit_logs
       WHERE session_id = s.id AND status = 'success'
         AND (session_context IS NOT NULL OR routing_context IS NOT NULL OR routing_intent IS NOT NULL)
       ORDER BY timestamp DESC
       LIMIT 1
     ) rt ON true
     LEFT JOIN LATERAL (
       SELECT session_context
       FROM audit_logs
       WHERE session_id = s.id AND status = 'success'
         AND session_context IS NOT NULL
       ORDER BY timestamp DESC
       LIMIT 1
     ) al ON true
     LEFT JOIN LATERAL (
       SELECT sanitized_content
       FROM messages
       WHERE session_id = s.id AND role = 'assistant'
       ORDER BY created_at ASC
       LIMIT 1
     ) am ON true
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COUNT(*)::integer                AS request_count,
         COALESCE(SUM(
           CASE
             WHEN model_pricing_snapshot IS NOT NULL
                  AND model_pricing_snapshot->>'inputPricePer1MTokens' IS NOT NULL
             THEN input_tokens * (model_pricing_snapshot->>'inputPricePer1MTokens')::numeric
                + output_tokens * (model_pricing_snapshot->>'outputPricePer1MTokens')::numeric
             ELSE input_tokens * 0.20 + output_tokens * 0.70
           END
         ), 0) / 1000000.0 AS estimated_cost
       FROM audit_logs
       WHERE session_id = s.id AND status = 'success'
     ) st ON true
     WHERE s.user_id = $1
     ORDER BY s.last_activity_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, pageSize, offset],
  );

  // Strip markdown formatting from preview — keep only meaningful text
  const stripMarkdown = (s: string): string =>
    s
      .replace(/\*\*(.+?)\*\*/g, '$1')      // **bold** → text
      .replace(/__(.+?)__/g, '$1')           // __underline__ → text
      .replace(/`{1,3}[^`]*`{1,3}/g, '')     // inline/block code → remove
      .replace(/^#{1,6}\s+/gm, '')           // # headings → remove
      .replace(/^\s*[-*+]\s+/gm, '')         // bullet lists → remove
      .replace(/\*{1,2}(.+?)\*{1,2}/g, '$1') // *italic* → text
      .replace(/\s+/g, ' ')                  // collapse whitespace
      .trim();

  const sessions: SessionWithStats[] = result.rows.map((row) => ({
    ...mapSessionRow(row),
    preview: row.preview ? stripMarkdown(row.preview) : null,
    totalInputTokens: parseInt(row.total_input_tokens ?? '0', 10),
    totalOutputTokens: parseInt(row.total_output_tokens ?? '0', 10),
    requestCount: parseInt(row.request_count ?? '0', 10),
    estimatedCost: row.estimated_cost ? parseFloat(row.estimated_cost) : null,
  }));

  return { sessions, total };
}

/**
 * Audit log row shape for per-session stats aggregation.
 */
interface StatsAuditRow {
  model_id: string;
  input_tokens: string;
  output_tokens: string;
  request_count: string;
  model_pricing_snapshot: Record<string, number> | null;
}

/**
 * Get aggregated token/cost statistics for a session from audit_logs.
 * Returns per-model breakdown with estimated cost from pricing snapshots.
 *
 * @see Requirements R6
 */
export async function getSessionStats(sessionId: string): Promise<SessionStats | null> {
  const result = await query<StatsAuditRow>(
    `SELECT
       model_id,
       SUM(input_tokens)::bigint  AS input_tokens,
       SUM(output_tokens)::bigint AS output_tokens,
       COUNT(*)::integer          AS request_count,
       model_pricing_snapshot
     FROM audit_logs
     WHERE session_id = $1 AND status = 'success'
     GROUP BY model_id, model_pricing_snapshot`,
    [sessionId],
  );

  if (result.rows.length === 0) return null;

  const breakdown: ModelBreakdown[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalRequests = 0;
  let totalCostUsd: number | null = 0;

  for (const row of result.rows) {
    const inputTokens = parseInt(row.input_tokens, 10);
    const outputTokens = parseInt(row.output_tokens, 10);
    const requestCount = parseInt(row.request_count, 10);
    const snapshot = row.model_pricing_snapshot;

    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalRequests += requestCount;

    let estimatedCostUsd: number | null = null;
    if (snapshot && typeof snapshot.inputPricePer1MTokens === 'number' && typeof snapshot.outputPricePer1MTokens === 'number') {
      // Use actual model pricing from snapshot (most accurate)
      estimatedCostUsd = (inputTokens * snapshot.inputPricePer1MTokens + outputTokens * snapshot.outputPricePer1MTokens) / 1_000_000;
    } else {
      // Fallback to blended average (matches sidebar sessionListCost calculation)
      // Used for historical sessions that predate the pricing snapshot column
      estimatedCostUsd = (inputTokens * 0.20 + outputTokens * 0.70) / 1_000_000;
    }

    totalCostUsd += estimatedCostUsd;

    breakdown.push({
      modelId: row.model_id,
      inputTokens,
      outputTokens,
      requestCount,
      estimatedCostUsd,
    });
  }

  return {
    sessionId,
    totalInputTokens,
    totalOutputTokens,
    requestCount: totalRequests,
    estimatedCostUsd: totalCostUsd,
    breakdown,
  };
}

/**
 * Resume (reactivate) an inactive/degraded/expired session.
 *
 * Transaction:
 *   1. Mark any currently active session for this user as inactive.
 *   2. Reactivate the target session with refreshed expires_at and last_activity_at.
 *
 * Throws SessionNotFoundError if the session doesn't exist or belongs to another user.
 * Idempotent — if the target is already active, just returns it.
 * Expired sessions can be resumed (their expiry is refreshed).
 *
 * @see Requirements R8
 */
export async function resumeSession(userId: string, sessionId: string): Promise<Session> {
  // Validate ownership and existence
  const session = await getSessionById(userId, sessionId);
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }

  // Already active — idempotent
  if (session.status === 'active') {
    return session;
  }

  // Transaction: deactivate current active + reactivate target
  const expiryHours = config.session.expiryHours;
  const result = await query<SessionRow>(
    `WITH deactivate AS (
       UPDATE sessions SET status = 'inactive', updated_at = NOW()
       WHERE user_id = $1 AND status = 'active'
     )
     UPDATE sessions
     SET status = 'active',
         last_activity_at = NOW(),
         expires_at = NOW() + INTERVAL '1 hour' * $2,
         updated_at = NOW()
     WHERE id = $3 AND user_id = $1
     RETURNING id, user_id, status, turn_count, created_at, updated_at, last_activity_at, expires_at, internal_document_context, internal_document_title`,
    [userId, expiryHours, sessionId],
  );

  return mapSessionRow(result.rows[0]);
}
