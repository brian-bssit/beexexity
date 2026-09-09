import { query } from '../config/database.js';
import { AuditEntry } from '../types/audit.types.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

interface PricingConfigFile {
  currency: string;
  lastUpdated: string;
  models: Record<string, { inputPricePer1MTokens: number; outputPricePer1MTokens: number }>;
}

/**
 * Audit Logger Service.
 * Persists request metadata to the audit_logs table asynchronously.
 * Fire-and-forget pattern — never blocks the inference response.
 *
 * Tahap 1: complexity/reasoning/routing-context/contract fields and the
 * orchestration (sequential-reasoning) fields are no longer written. The DB
 * columns remain (nullable) for historical rows and session preview queries.
 *
 * @see Requirements 8.1, 8.2, 8.3, 8.4
 */
class AuditService {
  private pricingCache: PricingConfigFile | null = null;
  private pricingCacheLoaded = false;

  /**
   * Load pricing config lazily, cache in memory. Never throws.
   * Returns the model's pricing as a snapshot object, or null if unavailable.
   */
  private getPricingSnapshot(modelId: string): Record<string, number> | null {
    if (!this.pricingCacheLoaded) {
      try {
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const configPath = join(__dirname, '..', 'frontend', 'pricing-config.json');
        const raw = readFileSync(configPath, 'utf-8');
        this.pricingCache = JSON.parse(raw) as PricingConfigFile;
      } catch {
        // Graceful degradation — pricing config is optional
        this.pricingCache = null;
      }
      this.pricingCacheLoaded = true;
    }

    const modelPricing = this.pricingCache?.models[modelId];
    if (!modelPricing) return null;

    const embeddingPricing = this.pricingCache?.models['cohere.embed-v4:0'];

    return {
      inputPricePer1MTokens: modelPricing.inputPricePer1MTokens,
      outputPricePer1MTokens: modelPricing.outputPricePer1MTokens,
      embeddingPricePer1MTokens: embeddingPricing?.inputPricePer1MTokens ?? 0,
    };
  }
  /**
   * Log an audit entry to the database.
   * This method is designed for fire-and-forget usage — callers should
   * invoke it without awaiting (or catch any rejection silently).
   *
   * Graceful degradation: if the DB insert fails, the error is logged
   * to console but never thrown to the caller.
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      // Capture model pricing snapshot for successful requests (for historical cost accuracy)
      const pricingSnapshot = entry.status === 'success'
        ? this.getPricingSnapshot(entry.modelId)
        : null;

      await query(
        `INSERT INTO audit_logs (
          timestamp,
          user_id,
          username,
          model_id,
          input_tokens,
          output_tokens,
          status,
          error_category,
          duration_ms,
          file_count,
          file_mime_types,
          total_file_size,
          is_multimodal,
          routing_state,
          routing_reason_code,
          executed_model_id,
          manual_override_applied,
          modality_flags,
          routing_flags,
          session_id,
          replayed_message_count,
          context_truncated,
          context_summarized,
          session_state,
          turn_count,
          model_pricing_snapshot,
          session_context,
          billed_user_id,
          billed_group,
          api_key_used,
          api_key_id,
          application_id,
          passthrough,
          knowledge_sources,
          embedding_input_tokens,
          tool_calls_meta,
          orchestration_meta
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37)`,
        [
          entry.timestamp,
          entry.userId,
          entry.username,
          entry.modelId,
          entry.inputTokens,
          entry.outputTokens,
          entry.status,
          entry.errorCategory ?? null,
          entry.durationMs,
          entry.fileCount ?? null,
          entry.fileMimeTypes ?? null,
          entry.totalFileSize ?? null,
          entry.isMultimodal ?? false,
          entry.routingState ?? null,
          entry.routingReasonCode ?? null,
          entry.executedModelId ?? null,
          entry.manualOverrideApplied ?? false,
          entry.modalityFlags ? JSON.stringify(entry.modalityFlags) : null,
          entry.routingFlags ?? null,
          entry.sessionId ?? null,
          entry.replayedMessageCount ?? null,
          entry.contextTruncated ?? false,
          entry.contextSummarized ?? false,
          entry.sessionState ?? null,
          entry.turnCount ?? null,
          pricingSnapshot ? JSON.stringify(pricingSnapshot) : null,
          entry.sessionContext ?? null,
          entry.billedUserId ?? null,
          entry.billedGroup ?? null,
          entry.apiKeyUsed ?? false,
          entry.apiKeyId ?? null,
          entry.applicationId ?? null,
          entry.passthrough ?? false,
          entry.knowledgeSourceIds ? JSON.stringify(entry.knowledgeSourceIds) : null,
          entry.embeddingInputTokens ?? null,
          entry.toolCallsMeta && entry.toolCallsMeta.length > 0 ? JSON.stringify(entry.toolCallsMeta) : null,
          entry.orchestrationMeta ? JSON.stringify(entry.orchestrationMeta) : null,
        ],
      );
    } catch (error) {
      // Graceful degradation: log to console but never crash
      console.error('[AuditService] Failed to persist audit log entry:', error);
    }
  }
}

export const auditService = new AuditService();
