-- 029: Knowledge ingestion job metadata — uploader + document classification,
-- so the admin dashboard can show who uploaded and how the doc is classified.
BEGIN;

ALTER TABLE knowledge_ingestion_jobs
    ADD COLUMN IF NOT EXISTS uploaded_by VARCHAR(255),
    ADD COLUMN IF NOT EXISTS doc_type VARCHAR(64),
    ADD COLUMN IF NOT EXISTS binding_level VARCHAR(16),
    ADD COLUMN IF NOT EXISTS source_type VARCHAR(16),
    ADD COLUMN IF NOT EXISTS sensitivity VARCHAR(16);

COMMIT;
