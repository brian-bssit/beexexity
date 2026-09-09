-- 034: Tier-1 internal tool-loop audit metadata.
-- One JSON array entry per executed tool call: {tool, args_masked, duration_ms,
-- result_chunks, result_size}. Args are PII-masked at write time — raw query/result
-- content is never persisted (metadata only, mirrors audit_logs content policy).
BEGIN;

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS tool_calls_meta JSONB DEFAULT '[]'::jsonb;

COMMIT;
