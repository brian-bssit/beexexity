-- 030: Promote knowledge classification fields to columns + 7-value binding_level + CHECK constraints.
-- binding_level/source_type/sensitivity move out of `metadata` JSONB into real columns
-- so they can be CHECK-constrained and indexed (consistent with knowledge_ingestion_jobs).
BEGIN;

-- 1. Add columns
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS binding_level VARCHAR(16),
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(16),
  ADD COLUMN IF NOT EXISTS sensitivity VARCHAR(16);

-- 2. Backfill from metadata JSONB
UPDATE knowledge_documents SET binding_level = metadata->>'binding_level' WHERE binding_level IS NULL;
UPDATE knowledge_documents SET source_type  = metadata->>'source_type'  WHERE source_type IS NULL;
UPDATE knowledge_documents SET sensitivity  = metadata->>'sensitivity'  WHERE sensitivity IS NULL;

-- 3. Normalize legacy binding_level (3 → 7)
UPDATE knowledge_documents SET binding_level = 'informational' WHERE binding_level = 'commentary';
UPDATE knowledge_documents SET binding_level = 'procedural'    WHERE binding_level = 'advisory';

-- 4. Normalize doc_type + sensitivity outliers
UPDATE knowledge_documents SET doc_type   = 'PRODUCT_FAQ' WHERE doc_type = 'FAQ';
UPDATE knowledge_documents SET doc_type   = 'MEMO'        WHERE doc_type = 'OTHER';
UPDATE knowledge_documents SET sensitivity = 'restricted' WHERE sensitivity = 'confidential';
UPDATE knowledge_documents SET sensitivity = 'internal'   WHERE sensitivity IS NULL;

-- Same normalization on the job table (before CHECK)
UPDATE knowledge_ingestion_jobs SET doc_type = 'PRODUCT_FAQ' WHERE doc_type = 'FAQ';
UPDATE knowledge_ingestion_jobs SET doc_type = 'MEMO'        WHERE doc_type = 'OTHER';
UPDATE knowledge_ingestion_jobs SET binding_level = 'informational' WHERE binding_level = 'commentary';
UPDATE knowledge_ingestion_jobs SET binding_level = 'procedural'    WHERE binding_level = 'advisory';
UPDATE knowledge_ingestion_jobs SET sensitivity = 'restricted' WHERE sensitivity = 'confidential';

-- 5. CHECK constraints — knowledge_documents
ALTER TABLE knowledge_documents DROP CONSTRAINT IF EXISTS chk_kd_doc_type;
ALTER TABLE knowledge_documents ADD CONSTRAINT chk_kd_doc_type CHECK (doc_type IN (
  'SOP','MEMO','REGULATION','PRODUCT_FAQ','HKR','HUK','AUDIT','JUKNIS','BRD','FSD','PKS','UAT','SIT',
  'PROJECT_CHARTER','IT_RD','HCP','CAB','ADR','SAF'
));
ALTER TABLE knowledge_documents DROP CONSTRAINT IF EXISTS chk_kd_binding_level;
ALTER TABLE knowledge_documents ADD CONSTRAINT chk_kd_binding_level CHECK (binding_level IN (
  'regulatory','contractual','procedural','directive','assessment','informational','other'
));
ALTER TABLE knowledge_documents DROP CONSTRAINT IF EXISTS chk_kd_source_type;
ALTER TABLE knowledge_documents ADD CONSTRAINT chk_kd_source_type CHECK (source_type IN ('official','internal','hukumonline'));
ALTER TABLE knowledge_documents DROP CONSTRAINT IF EXISTS chk_kd_sensitivity;
ALTER TABLE knowledge_documents ADD CONSTRAINT chk_kd_sensitivity CHECK (sensitivity IN ('restricted','internal','public'));

-- 6. CHECK constraints — knowledge_ingestion_jobs
ALTER TABLE knowledge_ingestion_jobs DROP CONSTRAINT IF EXISTS chk_kij_doc_type;
ALTER TABLE knowledge_ingestion_jobs ADD CONSTRAINT chk_kij_doc_type CHECK (doc_type IN (
  'SOP','MEMO','REGULATION','PRODUCT_FAQ','HKR','HUK','AUDIT','JUKNIS','BRD','FSD','PKS','UAT','SIT',
  'PROJECT_CHARTER','IT_RD','HCP','CAB','ADR','SAF'
));
ALTER TABLE knowledge_ingestion_jobs DROP CONSTRAINT IF EXISTS chk_kij_binding_level;
ALTER TABLE knowledge_ingestion_jobs ADD CONSTRAINT chk_kij_binding_level CHECK (binding_level IN (
  'regulatory','contractual','procedural','directive','assessment','informational','other'
));
ALTER TABLE knowledge_ingestion_jobs DROP CONSTRAINT IF EXISTS chk_kij_source_type;
ALTER TABLE knowledge_ingestion_jobs ADD CONSTRAINT chk_kij_source_type CHECK (source_type IN ('official','internal','hukumonline'));
ALTER TABLE knowledge_ingestion_jobs DROP CONSTRAINT IF EXISTS chk_kij_sensitivity;
ALTER TABLE knowledge_ingestion_jobs ADD CONSTRAINT chk_kij_sensitivity CHECK (sensitivity IN ('restricted','internal','public'));

COMMIT;
