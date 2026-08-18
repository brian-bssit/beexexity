/**
 * Knowledge Layer (Tier 2) — document upload & ingestion status.
 * @see docs/features/mcp-knowledge-layer/
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, apiKeyAuthMiddleware } from '../middleware/auth.middleware.js';
import { knowledgeUploadMiddleware, multerErrorHandler } from '../middleware/upload.middleware.js';
import { query } from '../config/database.js';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient } from '../services/inference.service.js';
import { extractDocumentText } from '../services/document-extractor.service.js';
import { indexDocument } from '../services/knowledge.service.js';
import type { IndexDocumentParams } from '../types/knowledge.types.js';

const router = Router();

/** Accept either a JWT (admin/IT) or an x-api-key (external app). */
async function eitherAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.headers['x-api-key']) {
    await apiKeyAuthMiddleware(req, res, next);
    return;
  }
  authMiddleware(req, res, next);
}

/** Optional metadata keys accepted in the `metadata` JSON field → IndexDocumentParams. */
const META_KEYS: Record<string, keyof IndexDocumentParams> = {
  version: 'version',
  effective_date: 'effectiveDate',
  expiry_date: 'expiryDate',
  domain: 'domain',
  sensitivity: 'sensitivity',
  jurisdiction: 'jurisdiction',
  source_type: 'sourceType',
  binding_level: 'bindingLevel',
};

/** Strip a leading Markdown YAML front-matter block (metadata arrives via the JSON field). */
function stripFrontMatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** Extract text from an uploaded buffer (raw for .md/.txt, extractor otherwise). */
async function extractContent(buffer: Buffer, mimetype: string, originalname: string, size: number): Promise<string> {
  if (mimetype === 'text/plain' || mimetype === 'text/markdown') {
    return stripFrontMatter(buffer.toString('utf-8')).trim();
  }
  const result = await extractDocumentText({ buffer, mimetype, originalname, size });
  return result.text.trim();
}

const METADATA_SYSTEM_PROMPT = `You extract structured metadata for an internal bank knowledge base.
Given a document's text, return ONLY valid JSON with these keys:
- "title": a concise, human-readable title that captures the document's actual subject, derived STRICTLY from the CONTENT (never from any filename — a file may be named generically like "download.pdf").
  • For a regulation/policy: issuer + number + year + subject, e.g. "Peraturan Bank Indonesia Nomor 32 Tahun 2025 tentang Pengaturan Industri Sistem Pembayaran".
  • For an SOP/procedure: the process or activity name, e.g. "SOP Pengajuan Kredit".
  • For a memo: the memo subject.
  • For a FAQ: the topic it answers.
  • Never return a generic label like "document", "download", or "untitled".
- "doc_type": exactly one of SOP, MEMO, REGULATION, PRODUCT_FAQ, HKR, HUK, AUDIT, JUKNIS, BRD, FSD, PKS, UAT, SIT, OTHER
- "binding_level": exactly one of regulatory, advisory, commentary
- "source_type": exactly one of official, internal, hukumonline
- "sensitivity": exactly one of internal, restricted, public

Classification rules:
- binding_level: "regulatory" for laws/regulations; "advisory" for SOP/procedures/guidelines; "commentary" for FAQ/interpretations/analysis.
- source_type: "official" for regulatory/government texts; "internal" for bank internal documents; "hukumonline" for third-party legal commentary.
- sensitivity: "public" only if the document is a published regulation/FAQ; "restricted" if it contains confidential/risk details; otherwise "internal".`;

/** Call qwen3-235b to suggest metadata from document text. Returns null on any failure. */
async function extractKnowledgeMetadata(text: string): Promise<Record<string, string> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const command = new ConverseCommand({
      modelId: 'qwen.qwen3-235b-a22b-2507-v1:0',
      system: [{ text: METADATA_SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: text.slice(0, 6000) }] }],
      inferenceConfig: { maxTokens: 512, temperature: 0 },
    });
    const response = await bedrockClient.send(command, { abortSignal: controller.signal });
    const output = response.output?.message?.content?.[0]?.text?.trim();
    if (!output) return null;
    const cleaned = output.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    return JSON.parse(cleaned) as Record<string, string>;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * POST /api/v1/knowledge/documents
 * Multipart upload: field `file` (document) + `metadata` (JSON string).
 * Required metadata: title, doc_type. Optional: version, effective_date,
 * expiry_date, domain[], sensitivity, jurisdiction[], source_type, binding_level.
 * Returns 202 Accepted { id, status: "processing" }; ingestion runs asynchronously.
 */
router.post('/documents', eitherAuth, knowledgeUploadMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'file is required (multipart field "file")' });
    return;
  }

  let meta: Record<string, unknown>;
  try {
    meta = typeof req.body?.metadata === 'string' && req.body.metadata.trim()
      ? JSON.parse(req.body.metadata) as Record<string, unknown>
      : {};
  } catch {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'metadata must be valid JSON' });
    return;
  }

  const title = typeof meta.title === 'string' ? meta.title.trim() : '';
  const docType = typeof meta.doc_type === 'string' ? meta.doc_type.trim().toUpperCase() : '';
  if (!title || !docType) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'metadata.title and metadata.doc_type are required' });
    return;
  }

  const params: Omit<IndexDocumentParams, 'content'> = {
    docType,
    title,
    sourceFile: req.file.originalname,
  };
  for (const [key, target] of Object.entries(META_KEYS)) {
    const value = meta[key];
    if (value !== undefined && value !== null && value !== '') {
      (params as Record<string, unknown>)[target] = value;
    }
  }

  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO knowledge_ingestion_jobs (source_file, status, uploaded_by, doc_type, binding_level, source_type, sensitivity)
       VALUES ($1, 'processing', $2, $3, $4, $5, $6) RETURNING id`,
      [
        req.file.originalname,
        req.user?.username ?? null,
        params.docType,
        params.bindingLevel ?? null,
        params.sourceType ?? null,
        params.sensitivity ?? null,
      ],
    );
    const jobId = rows[0].id;

    processIngestion({
      jobId,
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname,
      size: req.file.size,
      params,
    }).catch((err: unknown) => console.error('[knowledge] ingestion crashed:', (err as Error).message));

    res.status(202).json({ id: jobId, status: 'processing' });
  } catch (err: unknown) {
    console.error('[knowledge] upload failed:', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create ingestion job' });
  }
});

/**
 * POST /api/v1/knowledge/metadata/extract
 * Suggest metadata for a document via qwen3-235b (auto-prefill support).
 * Multipart: field `file`. Returns { metadata } or { metadata: null } on failure.
 */
router.post('/metadata/extract', eitherAuth, knowledgeUploadMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'file is required (multipart field "file")' });
    return;
  }
  try {
    const text = await extractContent(req.file.buffer, req.file.mimetype, req.file.originalname, req.file.size);
    if (!text) {
      res.json({ metadata: null });
      return;
    }
    const metadata = await extractKnowledgeMetadata(text);
    res.json({ metadata });
  } catch (err: unknown) {
    console.error('[knowledge] metadata extraction failed:', (err as Error).message);
    res.json({ metadata: null }); // graceful — frontend falls back to filename heuristic
  }
});

/**
 * GET /api/v1/knowledge/documents
 * List recent ingestion jobs (newest first). Query: ?limit= (default 50, max 100).
 */
router.get('/documents', eitherAuth, async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 50));
  try {
    const { rows } = await query(
      `SELECT id, source_file, status, chunks_indexed, error, created_at, completed_at,
              uploaded_by, doc_type, binding_level, source_type, sensitivity
       FROM knowledge_ingestion_jobs ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    res.json({ jobs: rows });
  } catch (err: unknown) {
    console.error('[knowledge] list failed:', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list ingestion jobs' });
  }
});

/**
 * GET /api/v1/knowledge/documents/:id/status
 * Poll ingestion status: processing | completed | failed.
 */
router.get('/documents/:id/status', eitherAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await query(
      `SELECT id, source_file, status, chunks_indexed, error, created_at, completed_at
       FROM knowledge_ingestion_jobs WHERE id = $1`,
      [req.params.id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Ingestion job not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err: unknown) {
    console.error('[knowledge] status query failed:', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load ingestion status' });
  }
});

// Convert multer/fileFilter errors into 400 responses (LIMIT_FILE_SIZE, UNSUPPORTED_FILE_TYPE, ...)
router.use(multerErrorHandler);

/** Background ingestion: extract → chunk/embed → insert → mark job completed/failed. */
async function processIngestion(input: {
  jobId: string;
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
  params: Omit<IndexDocumentParams, 'content'>;
}): Promise<void> {
  const { jobId, buffer, mimetype, originalname, size, params } = input;
  try {
    const content = await extractContent(buffer, mimetype, originalname, size);

    if (!content) throw new Error('Empty text extraction');

    const result = await indexDocument({ ...params, content });

    await query(
      `UPDATE knowledge_ingestion_jobs SET status = 'completed', chunks_indexed = $1, completed_at = NOW() WHERE id = $2`,
      [result.chunkIndex, jobId],
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await query(
      `UPDATE knowledge_ingestion_jobs SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2`,
      [message.slice(0, 500), jobId],
    ).catch(() => { /* never mask the original failure */ });
    console.error(`[knowledge] ingestion ${jobId} failed:`, message);
  }
}

export const knowledgeRouter = router;
