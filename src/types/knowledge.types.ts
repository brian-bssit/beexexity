/**
 * Knowledge Layer (Tier 2) types.
 * @see docs/features/mcp-knowledge-layer/
 */

/**
 * Closed-enum values enforced by PostgreSQL CHECK constraints (migrations 030) —
 * single source of truth for backend validation (PATCH /documents/:sourceFile/metadata).
 * Frontend (admin.html) hardcodes matching <option> lists — static HTML can't import TS.
 */
export const DOC_TYPES = [
  'SOP', 'MEMO', 'REGULATION', 'PRODUCT_FAQ', 'HKR', 'HUK', 'AUDIT',
  'JUKNIS', 'BRD', 'FSD', 'PKS', 'UAT', 'SIT', 'PROJECT_CHARTER',
  'IT_RD', 'HCP', 'CAB', 'ADR', 'SAF',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const BINDING_LEVELS = [
  'regulatory', 'contractual', 'procedural', 'directive',
  'assessment', 'informational', 'other',
] as const;
export type BindingLevel = (typeof BINDING_LEVELS)[number];

export const SOURCE_TYPES = ['official', 'internal', 'hukumonline'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SENSITIVITIES = ['restricted', 'internal', 'public'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

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
