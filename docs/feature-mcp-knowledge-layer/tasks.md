# Tasks: MCP Knowledge Layer (Tier 2)
## Feature: `mcp-knowledge-layer`

---

## Phase 1 — Database & Embedding Service

- [ ] **1.1** Migration 024: pgvector extension + `knowledge_documents` table + IVFflat index. [Req 1]
- [ ] **1.2** `src/types/knowledge.types.ts` — `KnowledgeChunk`, `KnowledgeDocument` interfaces. [Req 1, Req 3]
- [ ] **1.3** `src/services/embedding.service.ts` — `generateEmbedding()`, `embeddingToSql()`, `hashContent()`. [Req 2]
- [ ] **1.4** `src/services/knowledge.service.ts` — `indexDocument()` dengan chunking + dedup, `search()` dengan hybrid retrieval, `deleteDocument()`. [Req 1, Req 3, Req 4]
- [ ] **1.5** `tests/unit/embedding.service.test.ts` — mock Bedrock, test dimension validation, error handling. [Req 2]
- [ ] **1.6** `tests/unit/knowledge.service.test.ts` — mock pgvector, test search dedup, hybrid fallback, graceful degradation. [Req 1, Req 3, Req 5]

**Checkpoint — `npm test` & `npm run lint` harus pass. `npx tsx src/scripts/run-migrations.ts` di local.**

---

## Phase 2 — Ingestion Pipeline

- [ ] **2.1** `src/scripts/ingest-knowledge.ts` — CLI: baca folder → extract → chunk → embed → insert. [Req 4]
- [ ] **2.2** Recursive text splitter — 1000 token chunk, 100 token overlap, separator priority: `\n\n` → `\n` → `. ` → ` `. [Req 4.2]
- [ ] **2.3** Metadata extraction — dari nama file (convention: `{doc_type}_{title}.pdf`) atau JSON sidecar opsional. [Req 4.3]
- [ ] **2.4** Smoke test: ingest 3-5 dokumen sample (SOP, memo, FAQ) → verifikasi `knowledge_documents` table.

**Checkpoint — Semua dokumen sample ter-index, `SELECT count(*) FROM knowledge_documents` > 0.**

---

## Phase 3 — Retrieval Integration

- [ ] **3.1** Update `context-assembly.service.ts` — inject retrieval results ke system prompt setelah behavioral instructions. [Req 3]
- [ ] **3.2** Add citation instruction ke system prompt: "If you use information from reference documents, cite as [Sumber: {title}]." [Req 3.4]
- [ ] **3.3** Add 2s timeout wrapper di `knowledge.service.search()` untuk inference path. [Req 5]
- [ ] **3.4** `tests/unit/context-assembly.test.ts` — test context injection dengan dan tanpa retrieval results.

**Checkpoint — `npm test` & `npm run lint` harus pass. Prompt dengan keyword dari dokumen ter-index harus mengembalikan response dengan sitasi.**

---

## Phase 4 — Production Readiness

- [ ] **4.1** Run full test suite: `npm test`. Semua test harus pass. [All Req]
- [ ] **4.2** Linter: `npx eslint src/ tests/`. Zero errors pada file baru. [All Req]
- [ ] **4.3** Type-check: `npx tsc --noEmit`. Zero errors. [All Req]
- [ ] **4.4** Deploy migration 024 ke staging: `npx tsx src/scripts/run-migrations.ts` via Cloud Run.
- [ ] **4.5** Ingest korpus awal (5-10 dokumen) ke staging → verifikasi retrieval berfungsi di environment staging.
