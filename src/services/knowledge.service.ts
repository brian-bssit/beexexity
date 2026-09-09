/**
 * Knowledge Service — indexing and retrieval for the MCP Knowledge Layer (Tier 2).
 * Semantic retrieval (pgvector cosine) gated by a minimum relevance score.
 * Graceful degradation: any failure returns [] — inference never blocked.
 * @see docs/features/mcp-knowledge-layer/
 */

import { query } from '../config/database.js';
import { config } from '../config/index.js';
import { generateEmbeddings, embeddingToSql, hashContent } from './embedding.service.js';
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
  binding_level: string | null;
  source_type: string | null;
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
    bindingLevel: row.binding_level ?? null,
    sourceType: row.source_type ?? null,
    metadata,
  };
}

/** Tiebreaker: at equal distance, more-binding sources rank first (regulatory → other).
 *  Primary sort is semantic distance — ranking binding first demotes the most relevant
 *  non-regulatory chunk behind any 5 regulatory rows (e.g. a functional-spec answer to
 *  "jelaskan aplikasi digivisit" lost to irrelevant FAQ rows), wrongly emptying retrieval. */
const BINDING_LEVEL_ORDER = `CASE COALESCE(binding_level, 'informational')
  WHEN 'regulatory' THEN 0
  WHEN 'contractual' THEN 1
  WHEN 'procedural' THEN 2
  WHEN 'directive' THEN 3
  WHEN 'assessment' THEN 4
  WHEN 'informational' THEN 5
  ELSE 6 END`;

/** Legacy classification value remapping (pre-migration 030 → closed enum). */
const DOC_TYPE_MAP: Record<string, string> = { FAQ: 'PRODUCT_FAQ', OTHER: 'MEMO', DOC: 'MEMO' };
const BINDING_LEVEL_MAP: Record<string, string> = { advisory: 'procedural', commentary: 'informational' };
const SENSITIVITY_MAP: Record<string, string> = { confidential: 'restricted' };

async function searchInternal(queryText: string, topK: number): Promise<KnowledgeChunk[]> {
  const embedding = (await generateEmbeddings([queryText], 'search_query'))[0]!;
  const vec = embeddingToSql(embedding);

  const { rows } = await query<KnowledgeRow>(
    `SELECT id, content, title, doc_type, binding_level, source_type, metadata,
            1 - (embedding <=> $1::vector) AS score
     FROM knowledge_documents
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector, ${BINDING_LEVEL_ORDER}
     LIMIT $2`,
    [vec, topK],
  );

  // Pure semantic relevance gate: chunks below minRelevanceScore are "not covered"
  // by the KB, so they are dropped and retrieval returns [] — the sovereign routing
  // seam then escalates open text to Tier 3 (auto-tier-3). The keyword ILIKE fallback
  // that previously ran here resurrected one broad FAQ chunk for ANY weak-semantic
  // query via generic word overlap (e.g. "siapa presiden Indonesia saat ini" scores
  // 0.26 semantically yet matched FAQ words like "presiden"/"Indonesia"), so retrieval
  // was never empty and Tier-3 escalation never fired. See /audit + tier-3 fix.
  return rows.map(mapChunk).filter((c) => c.score >= config.knowledge.minRelevanceScore);
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
  if (params.jurisdiction) metadata.jurisdiction = params.jurisdiction;

  // Normalize legacy classification values to the closed enum (migration 030).
  const docType = DOC_TYPE_MAP[params.docType.toUpperCase()] ?? params.docType;
  const bindingLevel = params.bindingLevel
    ? (BINDING_LEVEL_MAP[params.bindingLevel] ?? params.bindingLevel)
    : null;
  const sensitivity = params.sensitivity
    ? (SENSITIVITY_MAP[params.sensitivity] ?? params.sensitivity)
    : null;

  let firstId = '';
  let inserted = 0;

  // Dedup in one query, then bulk-embed only the new chunks (large docs →
  // hundreds of chunks; batching keeps it to a handful of Bedrock calls).
  const hashes = chunks.map((c) => hashContent(c));
  const { rows: existing } = await query<{ content_hash: string }>(
    'SELECT content_hash FROM knowledge_documents WHERE content_hash = ANY($1::text[])',
    [hashes],
  );
  const existingSet = new Set(existing.map((r) => r.content_hash));
  const newChunks = chunks
    .map((content, i) => ({ content, index: i, contentHash: hashes[i]! }))
    .filter((c) => !existingSet.has(c.contentHash));

  for (let i = 0; i < newChunks.length; i += config.knowledge.embedBatchSize) {
    const batch = newChunks.slice(i, i + config.knowledge.embedBatchSize);
    const embeddings = await generateEmbeddings(
      batch.map((c) => c.content),
      'search_document',
      config.knowledge.embeddingBatchTimeoutMs,
    );

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j]!;
      const { rows } = await query<{ id: string }>(
        `INSERT INTO knowledge_documents
          (source_file, doc_type, title, chunk_index, content, content_hash, embedding, metadata,
           binding_level, source_type, sensitivity)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8::jsonb, $9, $10, $11)
         RETURNING id`,
        [
          params.sourceFile,
          docType,
          params.title,
          chunk.index,
          chunk.content,
          chunk.contentHash,
          embeddingToSql(embeddings[j]!),
          JSON.stringify(metadata),
          bindingLevel,
          params.sourceType ?? null,
          sensitivity,
        ],
      );
      if (rows[0]) {
        if (!firstId) firstId = rows[0].id;
        inserted++;
      }
    }
  }

  if (chunks.length > newChunks.length) {
    console.log(`[knowledge] Skipped ${chunks.length - newChunks.length} duplicate chunk(s): ${params.title}`);
  }

  return { id: firstId, chunkIndex: inserted };
}

/* ─── Admin management (grouped by source_file) ─────────────────────────── */

/** A single ingested document as exposed by the admin listing endpoint. */
export interface IngestedDocument {
  sourceFile: string;
  title: string | null;
  version: string | null;
  docType: string | null;
  bindingLevel: string | null;
  sensitivity: string | null;
  sourceType: string | null;
  chunkCount: number;
  createdAt: Date | string;
}

export interface IngestedDocumentFilters {
  search?: string | null;
  docType?: string | null;
  bindingLevel?: string | null;
  sensitivity?: string | null;
  sourceType?: string | null;
}

interface IngestedRow {
  source_file: string;
  title: string | null;
  version: string | null;
  doc_type: string | null;
  binding_level: string | null;
  sensitivity: string | null;
  source_type: string | null;
  chunk_count: number;
  created_at: Date | string;
}

/**
 * List ingested documents grouped by `source_file` (best-effort identity — see
 * docs/features/mcp-knowledge-layer + admin UI notice). Returns documents + total
 * for pagination.
 */
export async function getIngestedDocuments(
  filters: IngestedDocumentFilters,
  limit: number,
  offset: number,
): Promise<{ documents: IngestedDocument[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(`(title ILIKE $${params.length} OR source_file ILIKE $${params.length})`);
  }
  const exact: Array<[string, string | null | undefined]> = [
    ['doc_type', filters.docType],
    ['binding_level', filters.bindingLevel],
    ['sensitivity', filters.sensitivity],
    ['source_type', filters.sourceType],
  ];
  for (const [col, val] of exact) {
    if (val) {
      params.push(val);
      conditions.push(`${col} = $${params.length}`);
    }
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM knowledge_documents ${where}`,
    [...params], // copy — `params` is extended with limit/offset below for the list query
  );
  const total = Number(countRows[0]?.total ?? 0);

  params.push(limit, offset);
  const { rows } = await query<IngestedRow>(
    `SELECT source_file,
            MAX(title) AS title,
            MAX(metadata->>'version') AS version,
            MAX(doc_type) AS doc_type,
            MAX(binding_level) AS binding_level,
            MAX(sensitivity) AS sensitivity,
            MAX(source_type) AS source_type,
            COUNT(*)::int AS chunk_count,
            MIN(created_at) AS created_at
     FROM knowledge_documents
     ${where}
     GROUP BY source_file
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    documents: rows.map((r) => ({
      sourceFile: r.source_file,
      title: r.title,
      version: r.version, // null when unset — UI renders "-"
      docType: r.doc_type,
      bindingLevel: r.binding_level,
      sensitivity: r.sensitivity,
      sourceType: r.source_type,
      chunkCount: r.chunk_count,
      createdAt: r.created_at,
    })),
    total,
  };
}

export interface DocumentMetadataUpdate {
  title?: string;
  docType?: string;
  bindingLevel?: string;
  sensitivity?: string;
  sourceType?: string;
  version?: string;
}

/**
 * Update document-level metadata, cascading to every chunk of `sourceFile`.
 * Empty-string `version` is treated as absent (never overwrites an existing value).
 * Returns the number of chunks updated.
 */
export async function updateDocumentMetadata(
  sourceFile: string,
  update: DocumentMetadataUpdate,
): Promise<number> {
  const { rowCount } = await query(
    `UPDATE knowledge_documents SET
       title = COALESCE($1, title),
       doc_type = COALESCE($2, doc_type),
       binding_level = COALESCE($3, binding_level),
       sensitivity = COALESCE($4, sensitivity),
       source_type = COALESCE($5, source_type),
       metadata = CASE
         WHEN $6 IS NOT NULL AND $6 <> '' THEN
           jsonb_set(COALESCE(metadata, '{}'::jsonb), '{version}', to_jsonb($6::text))
         ELSE metadata
       END
     WHERE source_file = $7`,
    [
      update.title ?? null,
      update.docType ?? null,
      update.bindingLevel ?? null,
      update.sensitivity ?? null,
      update.sourceType ?? null,
      update.version ?? null,
      sourceFile,
    ],
  );
  return rowCount ?? 0;
}

/** Delete every chunk belonging to `sourceFile`. Returns the number deleted. */
export async function deleteDocumentBySourceFile(sourceFile: string): Promise<number> {
  const { rowCount } = await query('DELETE FROM knowledge_documents WHERE source_file = $1', [sourceFile]);
  return rowCount ?? 0;
}
