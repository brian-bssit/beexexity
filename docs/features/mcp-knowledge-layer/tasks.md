# Tasks: MCP Knowledge Layer (Tier 2)
## Feature: `mcp-knowledge-layer`

---

## Phase 1 — Database & Embedding Service

- [x] **1.1** Migration 024: pgvector extension + `knowledge_documents` table + IVFflat index. [Req 1]
- [x] **1.2** `src/types/knowledge.types.ts` — `KnowledgeChunk`, `KnowledgeDocument` interfaces. [Req 1, Req 3]
- [x] **1.3** `src/services/embedding.service.ts` — `generateEmbedding()`, `embeddingToSql()`, `hashContent()`. [Req 2]
- [x] **1.4** `src/services/knowledge.service.ts` — `indexDocument()` dengan chunking + dedup, `search()` dengan hybrid retrieval + ordering by `binding_level` (regulatory > advisory > commentary), `deleteDocument()`. [Req 1, Req 3, Req 4, Req 6]
- [x] **1.5** `tests/unit/embedding.service.test.ts` — mock Bedrock, test dimension validation, error handling. [Req 2]
- [x] **1.6** `tests/unit/knowledge.service.test.ts` — mock pgvector, test search dedup, hybrid fallback, graceful degradation. [Req 1, Req 3, Req 5]
- [x] **1.7** Migration 025: `audit_logs.knowledge_sources JSONB` — traceability jawaban → dokumen sumber. [Req 6]

**Checkpoint — `npm test` & `npm run lint` harus pass. `npx tsx src/scripts/run-migrations.ts` di local.**

---

## Phase 2 — Ingestion Pipeline

- [x] **2.1** `src/scripts/ingest-knowledge.ts` — CLI: baca folder → extract → chunk → embed → insert. [Req 4]
- [x] **2.2** Recursive text splitter — 1000 token chunk, 100 token overlap, separator priority: `\n\n` → `\n` → `. ` → `。` → ` `. [Req 4.2] (di `knowledge.service.ts`)
- [x] **2.3** Metadata extraction — dari nama file (convention: `{doc_type}_{title}.pdf`), JSON sidecar opsional, atau Markdown front-matter (YAML). [Req 4.3]
- [x] **2.4** Smoke test: 3 sample docs (`knowledge-samples/`) + command `npx tsx src/scripts/ingest-knowledge.ts --dir knowledge-samples`. ✅ 3 docs indexed, retrieval verified (embedding via `global.cohere.embed-v4:0`, 1536-dim).

**Checkpoint — Semua dokumen sample ter-index, `SELECT count(*) FROM knowledge_documents` > 0.**

---

## Phase 3 — Retrieval Integration

- [x] **3.1** Update `context-assembly.service.ts` — `buildKnowledgeSection()` + inject retrieval results ke system prompt setelah behavioral instructions (di `inference.routes.ts`). [Req 3]
- [x] **3.2** Add citation instruction ke system prompt: "If you use information from reference documents, cite as [Sumber: {title}, {section}]." [Req 3.4]
- [x] **3.3** Add 2s timeout wrapper di `knowledge.service.search()` untuk inference path. [Req 5] (sudah di Phase 1)
- [x] **3.4** `tests/unit/context-assembly.service.test.ts` — test `buildKnowledgeSection` dengan dan tanpa retrieval results.
- [x] **3.5** Update `audit.service.ts` — catat `knowledgeSourceIds` (chunk yang digunakan) ke `audit_logs.knowledge_sources`. [Req 6]

**Checkpoint — `npm test` & `npm run lint` harus pass. Prompt dengan keyword dari dokumen ter-index harus mengembalikan response dengan sitasi.**

---

## Phase 4 — Production Readiness

- [x] **4.1** Run full test suite: `npm test`. Semua test harus pass. [All Req] — **430/430 pass**
- [x] **4.2** Linter: `npx eslint src/ tests/`. Zero errors pada file baru. [All Req] — **0 errors file baru**
- [x] **4.3** Type-check: `npx tsc --noEmit`. Zero errors. [All Req]
- [ ] **4.4** Deploy migrations 024 & 025 ke staging: `npx tsx src/scripts/run-migrations.ts` via Cloud Run. — **menunggu env staging**
- [ ] **4.5** Ingest korpus awal (5-10 dokumen) ke staging → verifikasi retrieval berfungsi di environment staging. — **menunggu env staging**

---

## Phase 5 — API Upload (Req 4.1-4.3)

- [x] **5.1** Migration 027: `knowledge_ingestion_jobs` table — track upload → processing/completed/failed. [Req 4.2, Req 4.3]
- [x] **5.2** `src/middleware/upload.middleware.ts` — export `knowledgeUploadMiddleware` (single `file`). [Req 4.1]
- [x] **5.3** `src/routes/knowledge.routes.ts` — `POST /documents` (202 async) + `GET /documents/:id/status` polling. [Req 4.1-4.3]
- [x] **5.4** Mount `/api/v1/knowledge` di `app.ts`. [Req 4.1]
- [x] **5.5** `tests/unit/knowledge.routes.test.ts` — upload validation, 202, status polling, async completion. [Req 4.1-4.3]

**Checkpoint — `npm test` (436 pass) & `npm run lint` (0 errors) pass.**

---

## Phase 6 — Cohere Embedding Cost (audit + cost-reporting)

- [x] **6.1** Migration 028: `audit_logs.embedding_input_tokens INTEGER`. [Req 6, cost accuracy]
- [x] **6.2** `audit.service.ts` — snapshot + `embeddingPricePer1MTokens`; INSERT `embedding_input_tokens`. [cost accuracy]
- [x] **6.3** `inference.routes.ts` — emit `embedding` SSE event + audit `embeddingInputTokens`. [Req 5, cost]
- [x] **6.4** `cost-reporting.service.ts` — aggregate + include embedding cost di `estimatedCostUsd`. [cost accuracy]
- [x] **6.5** `pricing-config.json` — `cohere.embed-v4:0` ($0.12/1M input). [cost accuracy]

**Checkpoint — `npm test` (439 pass) pass; live: `embedding_input_tokens` + snapshot terekam di audit_logs.**
