-- 025: Audit traceability — link inference responses to knowledge sources (Req 6.5).
BEGIN;

ALTER TABLE audit_logs
    ADD COLUMN knowledge_sources JSONB;

COMMIT;
