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
  complexityScore?: number;
  routingReasonCode?: string;
  reasoningSummary?: string;
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

  // Sub-agent orchestration metadata (only present when orchestrator runs)
  orchestrationMeta?: {
    specs: Array<{ agentId: string; skill: string; prompt: string; targetModel?: string }>;
    results: Array<{
      agentId: string;
      status: 'success' | 'failed' | 'timeout';
      text: string;
      inputTokens: number;
      outputTokens: number;
      durationMs: number;
    }>;
    totalInputTokens: number;
    totalOutputTokens: number;
    plannerDurationMs: number;
    executeDurationMs: number;
    synthesisDurationMs: number;
    synthesizeUsed: boolean;
    summarizeTriggered: boolean;
  };

  // Routing context from the PromptContract
  routingContext?: string;
  routingIntent?: string;
  sessionContext?: string;

  // Sequential reasoning orchestration fields
  orchestrationGroupId?: string;
  orchestrationStepOrder?: number;

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
}
