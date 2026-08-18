-- 028: MCP Knowledge Layer — track Cohere Embed v4 usage in audit_logs.
-- embedding_input_tokens counts the retrieval-query embedding tokens consumed
-- per inference turn, so cost reporting can include embedding spend.
BEGIN;

ALTER TABLE audit_logs
    ADD COLUMN IF NOT EXISTS embedding_input_tokens INTEGER;

COMMIT;
