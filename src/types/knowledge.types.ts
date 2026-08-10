/**
 * Knowledge Layer (Tier 2) types.
 * @see docs/features/mcp-knowledge-layer/
 */

/** A single retrieved knowledge chunk, ready to be injected into the system prompt. */
export interface KnowledgeChunk {
  id: string;
  content: string;
  title: string;
  docType: string;
  /** Cosine similarity score (0-1). */
  score: number;
  /** regulatory | advisory | commentary — null when untagged. */
  bindingLevel: string | null;
  /** official | hukumonline | internal. */
  sourceType: string | null;
  metadata: Record<string, unknown> | null;
}

/** A stored knowledge document row (one chunk per row). */
export interface KnowledgeDocument {
  id: string;
  sourceFile: string;
  docType: string;
  title: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  version: string | null;
  domain: string[] | null;
  sensitivity: string | null;
  jurisdiction: string[] | null;
  effectiveDate: string | null;
  bindingLevel: string | null;
  sourceType: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** Input for knowledgeDocument indexing. */
export interface IndexDocumentParams {
  content: string;
  docType: string;
  title: string;
  sourceFile: string;
  version?: string;
  effectiveDate?: string;
  expiryDate?: string;
  domain?: string[];
  sensitivity?: string;
  jurisdiction?: string[];
  sourceType?: string;
  bindingLevel?: string;
}

/** Result of indexing one document (may span multiple chunk rows). */
export interface IndexDocumentResult {
  id: string;
  chunkIndex: number;
}
