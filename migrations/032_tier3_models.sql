-- 032: Tier-3 external model registry (OpenAI-compatible gateway, auto-only).
-- Admin-managed rows; one row marked default. Uniqueness of default enforced in service
-- (tier3.service setModels) — a partial index is unnecessary for an admin-only table.
BEGIN;

CREATE TABLE IF NOT EXISTS tier3_models (
  model_id   text PRIMARY KEY,          -- e.g. qwen3.7-flash-2026-07-15
  is_default boolean NOT NULL DEFAULT false,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed examples (documentation-by-example; admin edits freely via the dashboard).
INSERT INTO tier3_models (model_id, is_default) VALUES
  ('qwen3.7-flash-2026-07-15', true),
  ('MiniMax-M2.7-highspeed', false)
ON CONFLICT (model_id) DO NOTHING;

COMMIT;
