# Evaluasi & Rencana Implementasi: MCP Knowledge Layer (Tier 2)

## Sumber
- **Gap Analysis:** `docs/gap-analysis-blueprint-vs-implementation.md`
- **Referensi MCP SDK:** `/Volumes/Data/Anti Gravity/mcp-reference.md`
- **Blueprint TOGAF:** `/Volumes/Data/Anti Gravity/Blueprint-llm-gw.md`
- **Requirement Fase 1:** `/Volumes/Data/Anti Gravity/llm-gw-rd.md`

---

## 1. Klarifikasi: Dua Arti "MCP"

Blueprint menggunakan istilah "MCP" dalam dua konteks yang perlu dipisahkan:

| | MCP Protocol (SDK) | MCP Knowledge Layer (Tier 2) |
|:---|:---|:---|
| **Apa** | Protokol standar untuk AI mengakses tools & data eksternal | Lapisan pengetahuan internal bank (SOP, regulasi, memo) yang bisa di-query model |
| **Implementasi** | `@modelcontextprotocol/express` SDK | Vector DB + embedding + retrieval pipeline |
| **Blueprint reference** | "MCP v0" sebagai standar integrasi | "Tier 2 — MCP/knowledge layer" sebagai sumber data |
| **Urgensi** | Medium — standarisasi interface | **Critical** — nilai unik platform vs chat wrapper biasa |

**Keduanya saling melengkapi:** MCP Knowledge Layer menyimpan dokumen, MCP Protocol menyediakan interface standar untuk mengaksesnya.

---

## 2. Evaluasi MCP SDK (`@modelcontextprotocol/express`)

### 2.1 Kesesuaian dengan Codebase

| Faktor | Status |
|:---|:---|
| Tech stack (Node.js 24, TS 5.6, Express 4.21) | ✅ Full compatibility |
| Non-intrusive (mount di path terpisah) | ✅ `/mcp` tanpa ganggu `/api/v1/*` |
| Auth existing bisa dipakai ulang | ✅ `authMiddleware` + `apiKeyAuthMiddleware` |
| Production readiness | ✅ SDK v1.x stabil, v2 beta |
| Overhead | ✅ Thin adapter — latency tambahan <5ms |

### 2.2 Yang Bisa Diekspos sebagai MCP Tools

| Service Existing | MCP Tool | Nilai untuk AI Client |
|:---|:---|:---|
| `inference.service.ts` | `generate` | Inference via MCP — akses standar ke LLM |
| `document-extractor.service.ts` | `extract_document` | Ekstraksi teks dari file — preprocessing knowledge |
| `session.service.ts` | `get_session`, `list_sessions` | Manajemen konteks percakapan |
| `cost-reporting.service.ts` | `get_usage` | Monitoring — bisa dipanggil dari dashboard AI |

### 2.3 Batasan

MCP SDK hanya menyediakan **interface/protokol**, bukan knowledge layer itu sendiri. SDK tidak menyediakan:
- ❌ Vector database
- ❌ Embedding generation
- ❌ Document indexing
- ❌ Semantic search
- ❌ Retrieval pipeline

**SDK adalah lapisan presentasi — knowledge layer adalah lapisan data.** Keduanya perlu dibangun.

---

## 3. Rencana Implementasi: MCP Knowledge Layer (Tier 2)

### 3.1 Arsitektur Target

```
                          ┌──────────────────────────┐
                          │   Chat App / API Client  │
                          └────────────┬─────────────┘
                                       │
                          ┌────────────▼─────────────┐
                          │   LLM Gateway (existing) │
                          │   /api/v1/inference/*    │
                          └────────────┬─────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                                     │
          ┌────────▼────────┐                  ┌─────────▼─────────┐
          │  Prompt Builder │                  │  MCP Retrieve Tool│
          │  (existing)     │                  │  (NEW)            │
          └────────┬────────┘                  └─────────┬─────────┘
                   │                                     │
                   │                          ┌──────────▼──────────┐
                   │                          │  Knowledge Service  │
                   │                          │  (NEW)              │
                   │                          │  - search(query)    │
                   │                          │  - getContext(ids)  │
                   │                          └──────────┬──────────┘
                   │                                     │
                   │                          ┌──────────▼──────────┐
                   │                          │  Vector Store       │
                   │                          │  pgvector (NEW)     │
                   │                          │  - documents table  │
                   │                          │  - embeddings       │
                   │                          └──────────┬──────────┘
                   │                                     │
                   │                          ┌──────────▼──────────┐
                   │                          │  Ingestion Pipeline │
                   │                          │  (reuse existing)   │
                   │                          │  - doc-extractor    │
                   │                          │  - embed (NEW)      │
                   │                          │  - chunk + index    │
                   │                          └─────────────────────┘
                   │
          ┌────────▼────────┐
          │  LLM (Bedrock)  │
          │  + injected ctx │
          └─────────────────┘
```

### 3.2 Pilihan Teknologi

| Komponen | Pilihan | Alasan |
|:---|:---|:---|
| **Vector DB** | PostgreSQL pgvector | Sudah ada PostgreSQL (Cloud SQL). Tidak perlu infra baru. Satu query JOIN bisa gabung inference + retrieval. |
| **Embedding Model** | AWS Bedrock Titan Embeddings / Cohere Embed | Sudah dalam ekosistem Bedrock. Tidak perlu API key tambahan. Latency <100ms. |
| **Chunking** | Custom — recursive text splitter | Kontrol penuh atas ukuran chunk per tipe dokumen. SOP butuh chunk lebih besar dari memo. |
| **Ingestion** | Reuse `document-extractor.service.ts` | Sudah support PDF, DOCX, PPTX, XLSX, HTML, MD, TXT. Tinggal tambah embed + insert. |
| **Retrieval** | Hybrid: semantic (pgvector cosine) + keyword (ILIKE) | Recall lebih baik untuk query regulasi yang sering pakai istilah eksak. |

### 3.3 Fase Implementasi

#### Fase 1: Database & Embedding (3-5 hari)
- **Migration 024:** `knowledge_documents` table + pgvector extension
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE TABLE knowledge_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_file VARCHAR(512) NOT NULL,
    doc_type VARCHAR(64),       -- SOP, memo, regulation, product_faq, risk_assessment
    title VARCHAR(512),
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash VARCHAR(64),    -- dedup
    embedding VECTOR(1536),      -- Titan Embeddings dimension
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX idx_kd_embedding ON knowledge_documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  ```
- **`src/services/embedding.service.ts`:** Panggil Bedrock Titan Embeddings (`amazon.titan-embed-text-v2:0`), dimension 1536, latency <100ms
- **`src/services/knowledge.service.ts`:** `indexDocument(text, metadata)` → chunk + embed + insert, `search(query, limit)` → embed query → cosine similarity → return top-K

#### Fase 2: Ingestion Pipeline (2-3 hari)
- **`src/scripts/ingest-knowledge.ts`:** CLI script — baca folder dokumen → extract via `document-extractor.service.ts` → chunk → embed → insert ke `knowledge_documents`
- **Korpus awal (5-10 dokumen):** 2 SOP, 2 memo internal, 1 regulasi terpilih, 2 FAQ produk, 1 risk assessment
- **Format metadata JSONB:** `{ domain, sensitivity, source_type, binding_level, effective_date, owner }` — sesuai skema metadata blueprint Phase C

#### Fase 3: Retrieval Integration (2-3 hari)
- **Prompt enrichment di `context-assembly.service.ts`:** Sebelum kirim prompt ke LLM, query `knowledge.service.search(userPrompt, topK=3)`, inject hasil sebagai context block
- **System prompt update:** Tambah instruksi: "Use the provided reference documents to answer. Cite document titles when referencing specific policies."
- **Citation format:** `[Sumber: {doc_title}, {section}]` — model diminta menyertakan sitasi

#### Fase 4: MCP Protocol (Optional, 2-3 hari)
- **Mount MCP server di `/mcp`** menggunakan `@modelcontextprotocol/express@1.x`
- **Expose tools:** `search_knowledge`, `get_document`, `generate_with_context`
- **Auth:** reuse `authMiddleware` + `apiKeyAuthMiddleware`
- **Ini bisa ditunda** — knowledge layer berfungsi tanpa MCP protocol

### 3.4 Estimasi Total

| Fase | Durasi | Deliverable |
|:---|:---|:---|
| Fase 1 — DB + Embedding | 3-5 hari | pgvector, embedding service, knowledge service dasar |
| Fase 2 — Ingestion | 2-3 hari | CLI ingestion, korpus awal 5-10 dokumen |
| Fase 3 — Retrieval | 2-3 hari | Prompt enrichment, citation, context injection |
| Fase 4 — MCP Protocol | 2-3 hari | `/mcp` endpoint, tools exposure (optional) |
| **Total** | **9-14 hari** | Knowledge Layer v0 production-ready |

---

## 4. Risiko & Mitigasi

| Risiko | Dampak | Mitigasi |
|:---|:---|:---|
| Korpus awal tipis — retrieval return kosong | Chat tidak lebih berguna dari sebelumnya | Fallback graceful: jika no results, model tetap menjawab tanpa context (existing behavior) |
| pgvector performance di Cloud SQL | Latency retrieval >200ms | Index IVFflat dengan tuning lists. Hybrid search (keyword fallback) |
| Embedding cost Bedrock | Biaya per dokumen | Titan Embeddings murah ($0.0001/1K tokens). 100 dokumen = <$1. Embed sekali, query berkali-kali. |
| Kualitas chunking buruk | Retrieval tidak relevan | Recursive splitter dengan overlap. Tuning per doc_type (SOP butuh chunk 1000 token, FAQ butuh 500) |
| MCP SDK v1→v2 migration | Breaking changes di masa depan | Fase 4 ditunda sampai v2 stabil (Juli 2026). Knowledge layer tidak bergantung pada MCP protocol. |

---

## 5. Rekomendasi

1. **Mulai Fase 1+2+3 dulu (knowledge layer), tunda Fase 4 (MCP protocol).** Knowledge layer memberikan nilai langsung ke pengguna. MCP protocol hanya standarisasi interface — penting tapi tidak mendesak untuk MVP.

2. **Gunakan pgvector, bukan database vector terpisah.** PostgreSQL sudah production. Tidak perlu operasi infra baru. Query JOIN antara `audit_logs` dan `knowledge_documents` memungkinkan analytics terintegrasi.

3. **Mulai dengan 5-10 dokumen kurasi tinggi.** Lebih baik sedikit dokumen berkualitas yang selalu relevan daripada ratusan dokumen yang menghasilkan noise retrieval.

4. **Citation wajib dari hari pertama.** Tanpa sitasi, user tidak bisa membedakan jawaban dari knowledge base vs halusinasi model. Ini nilai kepatuhan yang dibutuhkan regulator.
