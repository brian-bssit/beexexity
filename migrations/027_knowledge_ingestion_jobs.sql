-- 027: MCP Knowledge Layer — ingestion job tracking for the async upload API.
-- POST /api/v1/knowledge/documents returns 202 immediately; this table tracks
-- processing → completed (chunks_indexed) / failed (error) for status polling.
BEGIN;

CREATE TABLE IF NOT EXISTS knowledge_ingestion_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_file VARCHAR(512) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'processing',
    chunks_indexed INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kij_status ON knowledge_ingestion_jobs(status, created_at DESC);

COMMIT;
