-- 026: MCP Knowledge Layer — Cohere Embed v4 emits fixed 1536-dim vectors.
-- The Bedrock inference profile rejects a `dimensions` request param, so the
-- native 1536 dimension is authoritative. Widens the column created at
-- VECTOR(1024) by migration 024 (safe: table is empty until first ingest).
BEGIN;

DROP INDEX IF EXISTS idx_kd_embedding;
ALTER TABLE knowledge_documents ALTER COLUMN embedding TYPE VECTOR(1536);
CREATE INDEX idx_kd_embedding ON knowledge_documents
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

COMMIT;
