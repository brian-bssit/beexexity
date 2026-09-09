-- 031: Admin management support — source_file lookup/grouping index.
-- Minimal approach: only source_file is indexed (GROUP BY in GET /documents/ingested
-- + WHERE in PATCH/DELETE /documents/:sourceFile). doc_type already indexed (024:23).
-- Low-cardinality columns (binding_level/sensitivity/source_type) skipped — seq scan
-- acceptable on a small table; ILIKE '%..%' cannot use a btree index anyway.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_knowledge_docs_source_file ON knowledge_documents(source_file);

COMMIT;
