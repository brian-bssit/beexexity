-- Migration 036: sticky internal document context on sessions
--
-- A Google Workspace document fetched via URL is *internal* material: once it enters a
-- conversation, the whole session must stay on private tiers (Tier-1 Bedrock / Tier-2
-- retrieval) and must never escalate to the external Tier-3 gateway. Previously the doc
-- text lived only in the turn that carried the URL, so a follow-up turn had no document
-- signal at all — it became a Tier-3 candidate (empty knowledge retrieval → external) and
-- was also answered without the document content.
--
-- Stored text is the PII-MASKED extraction (same posture as `messages.sanitized_content`),
-- capped at 50k chars to match the system-prompt injection. Rows are removed with the
-- session by normal expiry cleanup.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS internal_document_context TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS internal_document_title TEXT;
