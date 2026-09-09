/**
 * Audit logging types.
 * @see Requirements 8.1, 8.2, 8.3, 8.4
 */

export interface AuditEntry {
  timestamp: string;          // ISO 8601
  userId: string;
  username: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  status: 'success' | 'failed';
  errorCategory?: string;
  durationMs: number;

  // New fields for multimodal uploads
  fileCount?: number;
  fileMimeTypes?: string[];
  totalFileSize?: number;
  isMultimodal?: boolean;

  // Routing metadata fields
  routingState?: 'auto' | 'manual' | 'passthrough';
  routingReasonCode?: string;
  executedModelId?: string;
  manualOverrideApplied?: boolean;
  modalityFlags?: { textOnly: boolean; documentText: boolean; image: boolean; mixed: boolean };
  routingFlags?: string[];

  // Session memory fields
  sessionId?: string;
  replayedMessageCount?: number;
  contextTruncated?: boolean;
  contextSummarized?: boolean;

  // Session continuity fields
  sessionState?: string;
  turnCount?: number;

  // Pricing snapshot for historical cost accuracy
  modelPricingSnapshot?: Record<string, number> | null;

  // Short routing summary for the session list preview
  sessionContext?: string;

  // Billing context for machine-to-machine batch inference
  billedUserId?: string;
  billedGroup?: string;
  /** @deprecated Replaced by apiKeyId — presence of apiKeyId implies API key was used. */
  apiKeyUsed?: boolean;

  // Multi-tenant API key tracking
  apiKeyId?: string;
  applicationId?: string;

  // Passthrough mode flag
  passthrough?: boolean;

  // Knowledge Layer traceability — chunk ids used to answer the request
  knowledgeSourceIds?: string[];

  // Cohere Embed v4 usage — input tokens consumed by knowledge retrieval
  embeddingInputTokens?: number;

  // Tier-1 tool loop traceability — one entry per executed tool call.
  // Args are masked at write time; raw query/result content is never stored.
  toolCallsMeta?: ToolCallAuditMeta[];

  // Google Drive fetch audit (stored in orchestration_meta JSONB column).
  orchestrationMeta?: Record<string, unknown>;
}

/** One executed Tier-1 tool call, captured for audit (metadata only). */
export interface ToolCallAuditMeta {
  tool: string;
  /** PII-masked JSON of the tool args (masked before storage — raw never persisted). */
  args_masked: string;
  duration_ms: number;
  /** Number of knowledge chunks the tool returned (derived from the result text). */
  result_chunks: number;
  /** Character size of the tool result text. */
  result_size: number;
}
