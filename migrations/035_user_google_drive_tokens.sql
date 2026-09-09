-- Migration 035: User Google Drive OAuth tokens
-- Stores refresh tokens for Google Drive API access.
-- Token at-rest encryption relies on GCP Cloud SQL disk encryption + IAM (accepted risk).
-- No app-level encryption for MVP -- encryption key in .env is same threat model as DB password.

CREATE TABLE IF NOT EXISTS user_google_drive_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL,
  google_email VARCHAR(255) NOT NULL,
  granted_scopes TEXT[] NOT NULL DEFAULT ARRAY[
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/documents.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/presentations.readonly'
  ],
  last_refreshed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_gdrive_tokens_user_id
ON user_google_drive_tokens(user_id);

COMMENT ON TABLE user_google_drive_tokens IS
  'Google Drive OAuth refresh tokens. Token security via GCP Cloud SQL at-rest encryption + IAM (accepted risk for MVP).';
COMMENT ON COLUMN user_google_drive_tokens.refresh_token IS
  'OAuth refresh token. Not app-level encrypted -- relies on Cloud SQL disk encryption.';
