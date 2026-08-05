-- 022: Multi-tenant API key management
-- Creates applications and api_keys tables for database-backed API key auth.
-- Replaces the single GHOSTMEET_API_KEY env var with per-application keys.
BEGIN;

CREATE TABLE applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL UNIQUE,
    billing_mode VARCHAR(20) NOT NULL DEFAULT 'PER_APP'
        CHECK (billing_mode IN ('PER_APP', 'PER_USER')),
    created_by VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    key_prefix VARCHAR(16) NOT NULL,
    key_hash VARCHAR(255) NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_keys_application ON api_keys(application_id);
-- key_hash UNIQUE constraint already creates an index — no separate index needed

COMMIT;
