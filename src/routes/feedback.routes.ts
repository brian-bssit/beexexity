import { Router, Request, Response } from 'express';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient } from '../services/inference.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { adminMiddleware } from '../middleware/admin.middleware.js';
import { query } from '../config/database.js';

import type { ErrorResponse } from '../types/error.types.js';

const router = Router();

// ── User Submit Feedback ─────────────────────────────────────────────────

/**
 * POST /api/v1/feedback
 * Submit feedback for the last turn. Backend extracts routing metadata
 * from audit_logs and triggers background synthesis via qwen3-235b.
 *
 * Body: { sessionId, errorCategory, userFeedback, finalResponse, userPrompt?, routingContext? }
 */
router.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { sessionId, errorCategory, userFeedback, finalResponse, userPrompt, routingContext } = req.body;

  // Validate
  if (!sessionId || typeof sessionId !== 'string') {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'sessionId is required' });
    return;
  }
  if (!errorCategory || !['hallucination', 'missed_context', 'wrong_tone', 'formatting_issue', 'other'].includes(errorCategory)) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Valid errorCategory is required' });
    return;
  }
  if (!userFeedback || typeof userFeedback !== 'string' || userFeedback.trim().length < 10) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'userFeedback must be at least 10 characters' });
    return;
  }
  if (!finalResponse || typeof finalResponse !== 'string') {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'finalResponse is required' });
    return;
  }

  try {
    // Extract routing metadata from audit_logs for this session
    const { rows: routingRows } = await query(
      `SELECT complexity_score, routing_state, executed_model_id, model_id, input_tokens, output_tokens
       FROM audit_logs WHERE session_id = $1 AND status = 'success'
       ORDER BY timestamp DESC LIMIT 1`,
      [sessionId],
    );

    const routingMeta: Record<string, unknown> = routingRows.length > 0
      ? {
          complexityScore: routingRows[0].complexity_score,
          routingState: routingRows[0].routing_state,
          executedModelId: routingRows[0].executed_model_id,
          modelId: routingRows[0].model_id,
          inputTokens: routingRows[0].input_tokens,
          outputTokens: routingRows[0].output_tokens,
        }
      : {};

    // Enrich with frontend-provided context (user prompt + status-panel data)
    if (userPrompt && typeof userPrompt === 'string') routingMeta.userPrompt = userPrompt.trim();
    if (routingContext && typeof routingContext === 'string') routingMeta.routingContext = routingContext.trim();

    // Insert feedback report
    const { rows: inserted } = await query<{ id: string }>(
      `INSERT INTO feedback_reports (session_id, user_feedback, error_category, final_response, routing_metadata)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [sessionId, userFeedback.trim(), errorCategory, finalResponse, JSON.stringify(routingMeta)],
    );

    const reportId = inserted[0].id;

    // Fire-and-forget: run synthesis via qwen3-235b
    synthesizeReport(reportId, sessionId, userFeedback.trim(), errorCategory, finalResponse, routingMeta)
      .catch((err) => console.error('[feedback] Synthesis failed:', err.message));

    res.status(201).json({ id: reportId, message: 'Feedback submitted' });
  } catch (err: unknown) {
    console.error('[feedback] Submit failed:', (err as Error).message);
    const errorResponse: ErrorResponse = { error: 'INTERNAL_ERROR', message: 'Failed to submit feedback' };
    res.status(500).json(errorResponse);
  }
});

// ── Admin Endpoints ─────────────────────────────────────────────────────

/**
 * GET /api/v1/feedback/admin
 * List all feedback reports with optional filters.
 * Query: ?category=&skill=&status=&page=1&pageSize=20
 */
router.get('/admin', authMiddleware, adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { category, skill, status } = req.query;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (category && typeof category === 'string') {
    conditions.push(`error_category = $${idx++}`);
    params.push(category);
  }
  if (status && typeof status === 'string') {
    conditions.push(`status = $${idx++}`);
    params.push(status);
  }
  if (skill && typeof skill === 'string') {
    conditions.push(`routing_metadata->>'skill' = $${idx++}`);
    params.push(skill);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (page - 1) * pageSize;

  try {
    const countResult = await query<{ count: string }>(`SELECT COUNT(*)::text FROM feedback_reports ${where}`, params);
    const total = parseInt(countResult.rows[0]?.count || '0', 10);

    const { rows } = await query(
      `SELECT id, session_id, error_category, user_feedback, status, routing_metadata,
              alignment_summary, root_cause_analysis, recommendation, created_at
       FROM feedback_reports ${where}
       ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, pageSize, offset],
    );

    res.json({
      reports: rows,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err: unknown) {
    console.error('[feedback] Admin list failed:', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load reports' });
  }
});

/**
 * PUT /api/v1/feedback/admin/:id/status
 * Update report status. Body: { status: 'reviewed' | 'resolved' }
 */
router.put('/admin/:id/status', authMiddleware, adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { status: newStatus } = req.body;

  if (!newStatus || !['reviewed', 'resolved'].includes(newStatus)) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Status must be "reviewed" or "resolved"' });
    return;
  }

  try {
    await query(
      `UPDATE feedback_reports SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3`,
      [newStatus, req.user!.username, id],
    );
    res.json({ success: true });
  } catch (err: unknown) {
    console.error('[feedback] Status update failed:', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update status' });
  }
});

// ── Background Synthesis ────────────────────────────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are a Principal AI Engineer and Senior QA Analyst. Your task is to perform a deep-dive root cause analysis on a failed or suboptimal LLM response.

### TASK:
Analyze the LLM response and user feedback to determine what went wrong.

1. **Alignment Summary**: Briefly state the gap between what the user expected and what was produced.
2. **Root Cause Analysis**: Pinpoint the EXACT technical failure. (e.g., "The model failed to follow the format constraint specified in the prompt.")
3. **Actionable Recommendation**: What specific code, prompt, or routing logic needs to be changed?

### OUTPUT FORMAT (Strict JSON):
{
  "alignment_summary": "...",
  "root_cause_analysis": "...",
  "recommendation": "...",
  "confidence": "high | medium | low"
}`;

async function synthesizeReport(
  reportId: string,
  _sessionId: string,
  userFeedback: string,
  errorCategory: string,
  finalResponse: string,
  routingMeta: Record<string, unknown> | null,
): Promise<void> {
  const metaStr = routingMeta ? JSON.stringify(routingMeta, null, 2) : 'No routing metadata available';

  const userPrompt = [
    `User Feedback Category: ${errorCategory}`,
    `User Comment: ${userFeedback}`,
    '',
    `Routing Metadata:`,
    metaStr,
    '',
    `Final LLM Response:`,
    finalResponse,
  ].join('\n');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    const command = new ConverseCommand({
      modelId: 'qwen.qwen3-235b-a22b-2507-v1:0',
      system: [{ text: SYNTHESIS_SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: userPrompt }] }],
      inferenceConfig: { maxTokens: 2048, temperature: 0.2 },
    });

    const response = await bedrockClient.send(command, { abortSignal: controller.signal });
    clearTimeout(timeout);

    const outputText = response.output?.message?.content?.[0]?.text?.trim();
    if (!outputText) {
      console.warn('[feedback] Synthesis returned empty output');
      return;
    }

    // Parse JSON from response
    const cleaned = outputText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    await query(
      `UPDATE feedback_reports SET
        alignment_summary = $1,
        root_cause_analysis = $2,
        recommendation = $3
       WHERE id = $4`,
      [
        parsed.alignment_summary || null,
        parsed.root_cause_analysis || null,
        parsed.recommendation || null,
        reportId,
      ],
    );

    console.log(`[feedback] Synthesis complete for report ${reportId}`);
  } catch (err: unknown) {
    console.error(`[feedback] Synthesis failed for report ${reportId}:`, (err as Error).message);
    // Report already saved — synthesis failure is non-fatal
  }
}

export default router;
