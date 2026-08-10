-- 024: MCP Knowledge Layer (Tier 2) — pgvector storage for document embeddings.
-- Creates knowledge_documents table with IVFflat index for cosine similarity search.
BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_file VARCHAR(512) NOT NULL,
    doc_type VARCHAR(64),
    title VARCHAR(512),
    chunk_index INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    content_hash VARCHAR(16) NOT NULL,
    embedding VECTOR(1024),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kd_content_hash ON knowledge_documents(content_hash);
CREATE INDEX idx_kd_embedding ON knowledge_documents
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_kd_doc_type ON knowledge_documents(doc_type, created_at DESC);

COMMIT;
