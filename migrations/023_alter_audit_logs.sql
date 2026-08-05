-- 023: Extend audit_logs for multi-tenant API key cost tracking.
-- Adds api_key_id, application_id FKs and makes username nullable for PER_APP mode.
BEGIN;

-- Nullable username for PER_APP billing mode (no end-user context)
ALTER TABLE audit_logs ALTER COLUMN username DROP NOT NULL;

-- FK to api_keys and applications (ON DELETE SET NULL — preserve historical data)
ALTER TABLE audit_logs
    ADD COLUMN api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    ADD COLUMN application_id UUID REFERENCES applications(id) ON DELETE SET NULL;

-- Indexes for cost aggregation queries
CREATE INDEX idx_audit_logs_app_time ON audit_logs(application_id, timestamp);
CREATE INDEX idx_audit_logs_key_time ON audit_logs(api_key_id, timestamp);
CREATE INDEX idx_audit_logs_user_time ON audit_logs(username, timestamp)
    WHERE username IS NOT NULL;

COMMIT;
