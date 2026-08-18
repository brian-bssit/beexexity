# Design: MCP Knowledge Layer (Tier 2)
## Feature: `mcp-knowledge-layer`

---

## Architecture

### Data Flow (Inference with Knowledge Retrieval)

```
User Prompt
  │
  ▼
context-assembly.service.ts
  │  1. knowledge.service.search(userPrompt, topK=3)
  │  2. Jika results exist → inject ke system prompt sebagai context block
  │  3. Jika no results / error → fallback prompt tanpa context
  ▼
Inference (existing pipeline)
  │  system prompt + retrieved context + behavioral instructions + grounding
  ▼
LLM Response + [Sumber: ...] citations
```

### Ingestion Flow

```
Admin CLI
  │  npx tsx src/scripts/ingest-knowledge.ts --dir ./knowledge-docs/
  │  Supported: PDF, DOCX, MD, TXT, Markdown front-matter (YAML)
  │  Hukumonline: separate ingestion path with source tagging
  ▼
document-extractor.service.ts (reuse existing)
  │  PDF, DOCX, MD, TXT → text extraction → Markdown conversion
  ▼
Metadata Extraction
  │  From JSON sidecar or Markdown front-matter (YAML)
  │  Required: title, doc_type, domain[], sensitivity
  │  Optional: version, effective_date, expiry_date, jurisdiction[], category[]
  ▼
Chunking (recursive text splitter, 1000 tokens, 100 overlap)
  │
  ▼
embedding.service.ts (Cohere Embed v4, 1536d)
  │  text → Float32Array
  ▼
knowledge.service.indexDocument()
  │  INSERT INTO knowledge_documents (content, embedding, metadata, ...)
  │  Dedup: skip if content_hash already exists
  ▼
pgvector (IVFflat index, cosine similarity)
```

---

## Components & Interfaces

### New Files

#### `src/services/embedding.service.ts`
```
generateEmbedding(text: string, inputType: 'search_document' | 'search_query') → Float32Array
  // InvokeModel: global.cohere.embed-v4:0 (cross-region inference profile;
  // bare cohere.embed-v4:0 ditolak — on-demand throughput tidak didukung)
  // request: { texts, input_type, embedding_types: ['float'] } → fixed 1536-dim output
  // throws on dimension mismatch or empty response

embeddingToSql(emb: Float32Array) → string       // [0.1,0.2,...] for pgvector
hashContent(text: string) → string               // SHA-256 first 16 hex chars
```

#### `src/services/knowledge.service.ts`
```
indexDocument(params: {
  content: string, docType: string, title: string,
  sourceFile: string,
  version?: string, effectiveDate?: string, expiryDate?: string,
  domain?: string[], sensitivity?: string, jurisdiction?: string[],
  sourceType?: string, bindingLevel?: string
}) → { id: string, chunkIndex: number }
  // Chunk content if > maxChunkSize (1000 tokens) → recursive split
  // Generate embedding per chunk
  // INSERT with dedup check (content_hash)
  // Stores full metadata JSONB: core fields + classification tags + source tags

search(query: string, topK: number) → KnowledgeChunk[]
  // Embed query → cosine similarity via pgvector <=>
  // Fallback: ILIKE keyword search if max cosine < 0.4
  // Orders results by binding_level: 'regulatory' > 'advisory' > 'commentary'
  // Returns: [{ content, title, docType, score, metadata, bindingLevel, sourceType }]

deleteDocument(id: string) → void
```

#### `src/types/knowledge.types.ts`
```typescript
KnowledgeChunk {
  id: string; content: string; title: string;
  docType: string; score: number;   // cosine similarity 0-1
  bindingLevel: string | null;      // regulatory | advisory | commentary
  sourceType: string | null;        // official | hukumonline | internal
  metadata: Record<string, unknown> | null;
}
KnowledgeDocument {
  id: string; sourceFile: string; docType: string;
  title: string; chunkIndex: number; content: string;
  contentHash: string; version: string | null;
  domain: string[] | null; sensitivity: string | null;
  jurisdiction: string[] | null; effectiveDate: string | null;
  bindingLevel: string | null; sourceType: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
```

#### `src/scripts/ingest-knowledge.ts`
CLI script — usage: `npx tsx src/scripts/ingest-knowledge.ts --dir ./docs-kb/`
- Read all files in directory (PDF, DOCX, MD, TXT)
- Extract text via `extractDocumentText()`
- Chunk via recursive splitter
- Embed via `generateEmbedding()`
- Insert via `knowledge.service.indexDocument()`
- Output: file → chunks → skipped (dedup)

### Modified Files

#### `src/services/context-assembly.service.ts`
After behavioral instructions, before final assembly:
```
const knowledgeContext = await knowledgeService.search(prompt, 3);
if (knowledgeContext.length > 0) {
  systemPrompt += '\n\n--- REFERENCE DOCUMENTS ---\n';
  // Ordered by binding_level: regulatory > advisory > commentary
  systemPrompt += knowledgeContext.map(kc =>
    `[${kc.title}] (${kc.docType}, ${kc.sourceType ?? 'internal'}, relevance: ${(kc.score*100).toFixed(0)}%)\n${kc.content}`
  ).join('\n\n');
  systemPrompt += '\n\nIf you use information from these documents, cite as [Sumber: {title}, {section}]. Prefer sources marked "regulatory" over "commentary" when both address the same topic.';
}
```

#### `src/services/audit.service.ts`
Record `knowledge_document_ids` (chunk yang digunakan saat retrieval) ke `audit_logs.knowledge_sources JSONB` — setiap jawaban dapat di-trace kembali ke dokumen sumber (Req 6.5).

---

## Data Models

### Migration 024 — `024_knowledge_documents.sql`

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_file VARCHAR(512) NOT NULL,
    doc_type VARCHAR(64),
    title VARCHAR(512),
    chunk_index INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    content_hash VARCHAR(16) NOT NULL,
    embedding VECTOR(1536),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kd_content_hash ON knowledge_documents(content_hash);
CREATE INDEX idx_kd_embedding ON knowledge_documents
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_kd_doc_type ON knowledge_documents(doc_type, created_at DESC);
```

### Migration 025 — audit traceability

```sql
ALTER TABLE audit_logs
    ADD COLUMN IF NOT EXISTS knowledge_sources JSONB;
```

### Chunking Algorithm
```
RecursiveTextSplitter:
  maxChunkSize = 1000 tokens (~4000 chars)
  overlap = 100 tokens (~400 chars)
  separators = ["\n\n", "\n", ". ", "。", " "]
  Split on largest separator first. If chunk still too large, recurse with next separator.
```

---

## Error Handling

| Skenario | Perilaku |
|:---|:---|
| Titan Embeddings timeout (>2s) | Retry 1x, lalu throw — caller (ingest: abort, search: return empty) |
| pgvector query error | Log error, return `[]` — graceful degradation |
| Document > maxChunkSize (1000 tokens) | Auto-chunk via recursive splitter sebelum embed |
| Content hash collision (dedup) | Skip insert, log `[knowledge] Skipped duplicate: {title} chunk {n}` |
| `knowledge.service.search()` called during inference | Timeout 2s. Jika timeout → return `[]`, inference lanjut tanpa context |
| Metadata missing required fields (title, doc_type) | Reject ingestion entry, log warning, continue ke file berikutnya |
| Hukumonline content tanpa URL/provider ID | Tetap ingest, tapi flag `citation_incomplete = true` di metadata |

---

## Key Design Decisions

1. **pgvector, bukan Pinecone/Chroma.** PostgreSQL sudah production di Cloud SQL. pgvector extension gratis, maintenance nol, query JOIN dengan `audit_logs` memungkinkan analytics terintegrasi. Untuk <10K dokumen, IVFflat cukup.

2. **Hybrid search.** Cosine untuk semantic similarity, ILIKE untuk keyword eksak (penting untuk query regulasi seperti "Pasal 22 UU PDP"). Threshold 0.4 — di bawah itu hasil dianggap noise dan tidak di-inject.

3. **Embedding model: Cohere embed-v4, bukan Titan v2.** Titan Embed v2 tidak tersedia di ap-southeast-3 (hanya us-east-1). Cohere Embed v4 adalah satu-satunya model embedding di region ini. Latency di bawah target <200ms (Req 2.4). Tidak perlu API key tambahan.

4. **Citation mandatory dari prompt, bukan post-processing.** Lebih murah dan lebih akurat — model yang memutuskan kapan merujuk, bukan regex. Instruksi sitasi di system prompt, bukan di output parser.

5. **MCP Protocol SDK ditunda.** Knowledge layer berfungsi penuh tanpa SDK. SDK hanya standarisasi interface — nilai tambah rendah untuk MVP.

6. **binding_level ordering di retrieval.** Sumber regulator-official (`regulatory`) selalu diurutkan di atas Hukumonline commentary (`commentary`). Jika dua sumber membahas topik yang sama, model diinstruksikan untuk memprioritaskan yang regulatory. Ordering diterapkan di query (ORDER BY binding_level) dan diinstruksikan di system prompt.

7. **Hukumonline separate tagging.** Semua konten Hukumonline ditandai `source_type = hukumonline`, `binding_level = commentary` (default). Citation metadata (URL, provider ID) disimpan untuk traceability. Pemisahan ketat antara regulator-official dan commentary memungkinkan retrieval logic yang audit-ready.
