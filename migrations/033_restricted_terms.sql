-- 033: Admin-managed restricted-word lexicon for the sovereignty classifier.
-- A case-insensitive substring hit on the masked prompt/doc text forces a request private
-- (Tier 1) — it can never reach the external Tier-3 gateway. Admin adds/deletes rows live.
BEGIN;

CREATE TABLE IF NOT EXISTS restricted_terms (
  term       text PRIMARY KEY,           -- stored as written; matched lowercased
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Baseline examples (documentation-by-example; admin deletes/adds freely).
INSERT INTO restricted_terms (term) VALUES
  ('rahasia'), ('confidential'), ('internal'), ('classified'), ('rahasia bank'), ('data pribadi')
ON CONFLICT (term) DO NOTHING;

COMMIT;
