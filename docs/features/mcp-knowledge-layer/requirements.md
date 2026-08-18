# Requirements: MCP Knowledge Layer (Tier 2)
## Feature: `mcp-knowledge-layer`

---

## Overview
Lapisan pengetahuan internal (Tier 2) berbasis vector search (pgvector + Bedrock Cohere Embed v4) yang memungkinkan model AI mengakses dan menyitasi dokumen internal bank secara terstruktur — SOP, memo, HKR, HUK, audit, FAQ produk, teks regulasi resmi, dan konten Hukumonline. Prompt enrichment otomatis di inference time: query user → semantic search → inject top-3 dokumen relevan ke system prompt dengan instruksi sitasi.
- **Arsitektur Tier 2:** MCP-based knowledge services exposing enterprise documents and law/regulatory content as structured resources/tools (FR-T2-001). Tier 1 interactions dapat memanggil MCP tools untuk document search dan section retrieval (FR-T2-002).
- **MCP Protocol SDK:** Standarisasi interface via `@modelcontextprotocol/express` ditunda — fokus pada retrieval pipeline dulu.

## Glossary
- **Knowledge Document:** Satu chunk Markdown dari dokumen internal yang sudah di-embed dan di-index. Disimpan dengan structured metadata/front-matter dan tagged fields (FR-MCP-002).
- **Embedding:** Representasi vektor (1536 dimensi, Float32) dari teks yang memungkinkan pencarian semantik (cosine similarity).
- **Chunk:** Satu unit teks hasil splitting dokumen panjang. Overlap 10% antar chunk untuk menjaga konteks.
- **Citation:** Format `[Sumber: {judul}, {section}]` yang harus disertakan model saat merujuk dokumen internal. Setiap knowledge item harus menyimpan cukup provenance untuk mendukung user-visible citations dan source traceability (FR-MCP-003).
- **Metadata Schema:** Kontrak metadata kanonikal per dokumen — core fields (id, title, version, status, effective_date, expiry_date) + classification tags (domain, category, sensitivity, jurisdiction) sesuai §7 dokumen requirement.

---

## Requirements

### [Req 1] Document Storage & Indexing
**User Story:** Admin dapat mengindeks dokumen internal ke knowledge base untuk digunakan saat inference.

**Acceptance Criteria:**
1. Tabel `knowledge_documents` menggunakan pgvector dengan kolom `embedding VECTOR(1536)`, `content TEXT`, `doc_type VARCHAR`, `title VARCHAR`, `metadata JSONB`.
2. Index IVFflat untuk cosine similarity search — cocok untuk <10,000 dokumen.
3. Content hash (SHA-256, 16 char) untuk deduplikasi saat ingestion — chunk yang sama tidak di-insert ulang.
4. **Knowledge Domains (FR-MCP-001, FR-WF-004):** Sistem mendukung minimal domain dokumen berikut:
   - SOP and procedures (`SOP`)
   - Internal memos (`MEMO`)
   - Business Requirement Document (`BRD`)
   - Functionality Specification Document (`FSD`)
   - Project Charter (`PROJECT_CHARTER`)
   - IT Requirement Document (`IT_RD`)
   - Perjanjian Kerja Sama (`PKS`)
   - Hardware Capacity Plan (`HCP`)
   - Change Advisory Board (`CAB`)
   - Architectural Decision Review (`ADR`)
   - Solution Architecture Forum (`SAF`)
   - Hasil Kajian Risiko (`HKR`)
   - Hasil Uji Kepatuhan (`HUK`)
   - Audit documents (`AUDIT`)
   - Product FAQ (`PRODUCT_FAQ`)
   - Petunjuk Teknis (`JUKNIS`)
   - User Acceptance Test (`UAT`)
   - System Integration Test (`SIT`)
   - Official regulatory texts (`REGULATION`)
   - Hukumonline content (`HUKUMONLINE`) — **placeholder, integrasi belum dieksekusi di fase ini**
5. **Metadata Schema (§7):** Setiap dokumen menyimpan metadata kanonikal:
   - Core fields: `id` (stable identifier), `title`, `version`, `status` (active/archived), `effective_date`, `expiry_date`
   - Classification tags: `domain[]` (risk, product, compliance, audit), `category[]` (credit, operational), `sensitivity` (restricted/internal/public), `jurisdiction[]` (Indonesia)
   - Source tags: `source_type` (official/hukumonline/internal), `binding_level` (regulatory/commentary/advisory)
6. **Markdown format (FR-MCP-002):** Knowledge artifacts disimpan sebagai Markdown dengan structured front-matter. Konversi dari format asli (PDF, DOCX) ke Markdown dilakukan saat ingestion.

### [Req 2] Embedding Generation
**User Story:** Sistem dapat menghasilkan vector embedding dari teks dokumen menggunakan AWS Bedrock.

**Acceptance Criteria:**
1. Model: `global.cohere.embed-v4:0` (cross-region inference profile; bare `cohere.embed-v4:0` ditolak karena on-demand throughput tidak didukung di ap-southeast-3), 1536 dimensi, normalized (unit vector).
2. Input maksimal 8000 token per call — teks yang lebih panjang harus di-chunk sebelum embed.
3. Embedding service terpisah (`embedding.service.ts`) — reusable untuk use case selain knowledge layer.
4. Latency target: <200ms per embedding call.
5. Retry 1x dengan backoff 500ms pada gagal — Bedrock throttling session-based.

### [Req 3] Retrieval Pipeline
**User Story:** Saat user mengirim prompt, sistem otomatis mencari dokumen relevan dan menyuntikkannya ke konteks inference.

**Acceptance Criteria:**
1. `knowledge.service.search(query, topK)` — embed query → cosine similarity via pgvector `<=>` operator → return top-K chunks.
2. Hybrid search: semantic (cosine) sebagai primary, keyword (ILIKE) sebagai fallback jika cosine score < 0.4.
3. Hasil retrieval di-inject ke system prompt sebagai context block di bawah behavioral instructions.
4. System prompt menambahkan instruksi sitasi: "If you use information from the reference documents below, cite the source as [Sumber: {title}, {section}]."
5. Jika retrieval tidak menghasilkan match (score < 0.3), prompt tetap dikirim tanpa context — graceful degradation.

### [Req 4] Document Upload & Ingestion Pipeline
**User Story:** Aplikasi eksternal (workflow app, document management, portal compliance) dapat meng-upload dokumen ke knowledge base melalui API. Dokumen otomatis dikonversi ke Markdown, di-chunk, di-embed, dan di-index untuk retrieval inference. Admin juga dapat mengingest dokumen secara batch via CLI.

**Acceptance Criteria:**
1. `POST /api/v1/knowledge/documents` — endpoint upload dokumen. Menerima multipart file (PDF, DOCX, XLSX, PPTX, MD, TXT, HTML, JSON, CSV, XML) + metadata JSON (title, doc_type wajib; version, effective_date, domain[], sensitivity opsional).
2. Request diterima → return `202 Accepted` dengan `{ id, status: "processing" }`. Pemrosesan async: convert to Markdown → chunk → embed → insert.
3. `GET /api/v1/knowledge/documents/:id/status` — polling status ingestion: `processing`, `completed` (dengan `chunks_indexed` count), `failed` (dengan `error` message).
4. Chunking: recursive text splitter, ukuran chunk ~1000 token, overlap 100 token.
5. Deduplikasi berdasarkan content hash — chunk yang sudah ada tidak di-re-embed.
6. **Document Conversion:** Semua format file dikonversi ke Markdown sebelum chunking via `document-extractor.service.ts` (existing, sudah support 10+ format). Markdown yang dihasilkan menyimpan struktur heading, tabel, dan list.
7. **Workflow Integration (FR-MCP-004/005):** Aplikasi workflow/document management dapat memanggil endpoint upload begitu dokumen approved — no manual step needed (FR-MCP-004). Konversi ke tagged Markdown otomatis (FR-MCP-005).
8. **Hukumonline Content (FR-HOL-001–005) — PLACEHOLDER:** Endpoint upload disiapkan untuk mendukung konten Hukumonline di fase berikutnya dengan:
   - Source tagging: `source_type = hukumonline`, `binding_level = commentary` (default)
   - Citation metadata: title, URL, provider-specific identifier
   - Strict separation: regulator-official vs Hukumonline commentary — retrieval logic memprioritaskan sumber otoritatif
   - **Belum dieksekusi di fase ini.** Schema dan tagging sudah disiapkan, integrasi aktual menyusul.
9. **CLI Batch Ingestion:** `src/scripts/ingest-knowledge.ts` — baca folder dokumen → extract → chunk → embed → insert. Untuk use case bulk migration atau ingestion awal.

### [Req 5] Graceful Degradation
**User Story:** Inference tetap berfungsi normal meskipun knowledge service gagal.

**Acceptance Criteria:**
1. Jika `knowledge.service.search()` error (DB down, embedding timeout) → fallback ke prompt tanpa context enrichment.
2. Error dicatat ke console log — tidak dilempar ke user.
3. Tidak ada tambahan latency di jalur inference jika knowledge service gagal — timeout retrieval 2 detik.

### [Req 6] Citation & Source Provenance
**User Story:** Setiap knowledge item yang di-retrieve harus menyertakan provenance cukup untuk user-visible citation dan audit traceability (FR-MCP-003, FR-HOL-003).

**Acceptance Criteria:**
1. Setiap chunk knowledge menyimpan `title`, `doc_type`, `source_file`, dan metadata lengkap untuk rekonstruksi sumber.
2. System prompt menyertakan instruksi: "If you use information from the reference documents below, cite the source as [Sumber: {title}, {section}]."
3. Hukumonline artifacts menyimpan citation metadata tambahan: URL, provider-specific identifier (FR-HOL-003). **Placeholder — integrasi Hukumonline belum dieksekusi di fase ini.**
4. Retrieval logic memprioritaskan sumber regulator-official (`REGULATION`) di atas sumber advisory/commentary — ordering di results berdasarkan `binding_level`: `regulatory` > `advisory` > `commentary`. **Hukumonline ordering (FR-HOL-004) placeholder.**
5. Response model harus dapat di-trace kembali ke dokumen sumber melalui `knowledge_documents.id` yang direferensikan di audit log.

---

## Out of Scope (Eksplisit)
- MCP Protocol SDK (`@modelcontextprotocol/express`) — ditunda ke Fase 4
- Admin UI untuk manajemen knowledge base — CLI only untuk MVP
- Full MCP management UI — future phase
- Multi-tenant knowledge base (per divisi) — satu knowledge base global
- Auto-sync knowledge base dari source system (SharePoint, Google Drive) — workflow-based ingestion sebagai gantinya (FR-MCP-004)
- Budget/rate limiting untuk embedding calls
- Self-hosted sovereign GPU inference (Tier 1 end-state) — Fase 4
- Tier 3 external commercial inference providers — Fase 3
- Customer-facing chatbot features — Fase 4
- Near real-time sync otomatis dari workflow app — integrasi manual via CLI dulu; auto-sync menyusul
