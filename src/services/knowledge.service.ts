/**
 * Knowledge Service — indexing and retrieval for the MCP Knowledge Layer (Tier 2).
 * Hybrid search: semantic (pgvector cosine) primary, keyword (ILIKE) fallback.
 * Graceful degradation: any failure returns [] — inference never blocked.
 * @see docs/features/mcp-knowledge-layer/
 */

import { query } from '../config/database.js';
import { config } from '../config/index.js';
import { generateEmbedding, embeddingToSql, hashContent } from './embedding.service.js';
import type {
  IndexDocumentParams,
  IndexDocumentResult,
  KnowledgeChunk,
} from '../types/knowledge.types.js';

const CHARS_PER_TOKEN = 4;

/** Recursive text splitter — largest separator first, with token-based overlap. */
function splitIntoChunks(text: string, maxChars: number, overlapChars: number): string[] {
  const separators = ['\n\n', '\n', '. ', '。', ' '];
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxChars) {
    let splitAt = -1;
    for (const sep of separators) {
      const idx = remaining.lastIndexOf(sep, maxChars);
      if (idx > 0) {
        splitAt = idx;
        break;
      }
    }
    if (splitAt === -1) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt).trim());
    // Next chunk starts at the previous split point minus overlap — keeps boundary context.
    remaining = remaining.slice(Math.max(0, splitAt - overlapChars)).trim();
  }
  if (remaining.length > 0) chunks.push(remaining.trim());

  return chunks.filter((c) => c.length > 0);
}

interface KnowledgeRow {
  id: string;
  content: string;
  title: string | null;
  doc_type: string | null;
  metadata: Record<string, unknown> | null;
  score?: number;
}

function mapChunk(row: KnowledgeRow): KnowledgeChunk {
  const metadata = row.metadata ?? {};
  return {
    id: row.id,
    content: row.content,
    title: row.title ?? 'untitled',
    docType: row.doc_type ?? 'unknown',
    score: row.score ?? 0,
    bindingLevel: (metadata.binding_level as string | undefined) ?? null,
    sourceType: (metadata.source_type as string | undefined) ?? null,
    metadata,
  };
}

/** Deterministic ordering: regulatory sources always rank above advisory/commentary. */
const BINDING_LEVEL_ORDER = `CASE COALESCE(metadata->>'binding_level', 'commentary')
  WHEN 'regulatory' THEN 0 WHEN 'advisory' THEN 1 ELSE 2 END`;

/** Common stopwords + question words — dropped from keyword queries. */
const STOPWORDS = new Set([
  'apa', 'apakah', 'bagaimana', 'berapa', 'mengapa', 'mana', 'kapan',
  'yang', 'dan', 'atau', 'untuk', 'dari', 'dengan', 'pada', 'ini', 'itu',
  'adalah', 'saya', 'anda', 'kita', 'kami', 'kamu', 'mereka',
  'di', 'ke', 'se', 'tentang', 'mengenai', 'harus', 'boleh', 'bisa',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'how',
  'of', 'to', 'in', 'on', 'and', 'for',
]);

/** Tokenize a query into significant keywords for keyword-based retrieval. */
function tokenizeKeywords(text: string): string[] {
  const words = text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

async function searchInternal(queryText: string, topK: number): Promise<KnowledgeChunk[]> {
  const embedding = await generateEmbedding(queryText, 'search_query');
  const vec = embeddingToSql(embedding);

  const { rows } = await query<KnowledgeRow>(
    `SELECT id, content, title, doc_type, metadata,
            1 - (embedding <=> $1::vector) AS score
     FROM knowledge_documents
     WHERE embedding IS NOT NULL
     ORDER BY ${BINDING_LEVEL_ORDER}, embedding <=> $1::vector
     LIMIT $2`,
    [vec, topK],
  );

  const semantic = rows.map(mapChunk);
  const maxScore = semantic[0]?.score ?? 0;

  // Hybrid fallback: semantic below threshold → tokenized keyword OR-match.
  if (semantic.length === 0 || maxScore < config.knowledge.hybridThreshold) {
    const keywords = tokenizeKeywords(queryText);
    if (keywords.length === 0) return [];

    const orClauses = keywords.map((_, i) => `content ILIKE $${i + 1}`).join(' OR ');
    const matchScore = keywords.map((_, i) => `(content ILIKE $${i + 1})::int`).join(' + ');
    const { rows: kwRows } = await query<KnowledgeRow>(
      `SELECT id, content, title, doc_type, metadata
       FROM knowledge_documents
       WHERE ${orClauses}
       ORDER BY (${matchScore}) DESC, ${BINDING_LEVEL_ORDER}, created_at DESC
       LIMIT $${keywords.length + 1}`,
      [...keywords.map((k) => `%${k}%`), topK],
    );
    return kwRows.map((r) => mapChunk(r));
  }

  // Semantic path: drop low-relevance noise.
  return semantic.filter((c) => c.score >= config.knowledge.minRelevanceScore);
}

/**
 * Search the knowledge base. Self-timeouts (default 2s) and degrades to [] on
 * any failure or timeout — the inference path is never blocked.
 */
export async function search(queryText: string, topK: number): Promise<KnowledgeChunk[]> {
  try {
    return await Promise.race([
      searchInternal(queryText, topK),
      new Promise<KnowledgeChunk[]>((resolve) =>
        setTimeout(() => resolve([]), config.knowledge.searchTimeoutMs),
      ),
    ]);
  } catch (error) {
    console.error('[knowledge] search failed:', (error as Error).message);
    return [];
  }
}

/**
 * Index a document: chunk → embed → dedup → insert.
 * Returns the first chunk id and the number of chunks inserted.
 */
export async function indexDocument(params: IndexDocumentParams): Promise<IndexDocumentResult> {
  const maxChars = config.knowledge.chunkSizeTokens * CHARS_PER_TOKEN;
  const overlapChars = config.knowledge.chunkOverlapTokens * CHARS_PER_TOKEN;
  const chunks = splitIntoChunks(params.content, maxChars, overlapChars);

  const metadata: Record<string, unknown> = {};
  if (params.version) metadata.version = params.version;
  if (params.effectiveDate) metadata.effective_date = params.effectiveDate;
  if (params.expiryDate) metadata.expiry_date = params.expiryDate;
  if (params.domain) metadata.domain = params.domain;
  if (params.sensitivity) metadata.sensitivity = params.sensitivity;
  if (params.jurisdiction) metadata.jurisdiction = params.jurisdiction;
  if (params.sourceType) metadata.source_type = params.sourceType;
  if (params.bindingLevel) metadata.binding_level = params.bindingLevel;

  let firstId = '';
  let inserted = 0;

  for (let i = 0; i < chunks.length; i++) {
    const contentHash = hashContent(chunks[i]!);

    const existing = await query<{ id: string }>(
      'SELECT id FROM knowledge_documents WHERE content_hash = $1 LIMIT 1',
      [contentHash],
    );
    if (existing.rows.length > 0) {
      console.log(`[knowledge] Skipped duplicate: ${params.title} chunk ${i}`);
      continue;
    }

    const embedding = await generateEmbedding(chunks[i]!);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO knowledge_documents
        (source_file, doc_type, title, chunk_index, content, content_hash, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8::jsonb)
       RETURNING id`,
      [
        params.sourceFile,
        params.docType,
        params.title,
        i,
        chunks[i]!,
        contentHash,
        embeddingToSql(embedding),
        JSON.stringify(metadata),
      ],
    );
    if (rows[0]) {
      if (!firstId) firstId = rows[0].id;
      inserted++;
    }
  }

  return { id: firstId, chunkIndex: inserted };
}

/** Delete a knowledge document chunk by id. */
export async function deleteDocument(id: string): Promise<void> {
  await query('DELETE FROM knowledge_documents WHERE id = $1', [id]);
}
