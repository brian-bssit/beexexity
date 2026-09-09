/**
 * Routing engine types and interfaces.
 * Tahap 1: skill taxonomy collapsed to a single deterministic 'fallback' —
 * the LLM classifier/refiner/verifier and their contract types are removed.
 */

// Re-export ModalityFlags from the canonical definition in inference.types.ts
export type { ModalityFlags } from './inference.types.js';

import type { ModalityFlags } from './inference.types.js';

/**
 * Skill type — collapsed to a single deterministic fallback.
 * Only the fallback role/format remain (used by manual, passthrough, and auto).
 */
export type SkillType = 'fallback';

/**
 * Input to the routing engine for determining model selection.
 * All text fields should already be PII-masked before reaching this interface.
 */
export interface RoutingInput {
  originalPrompt: string;           // Already PII-masked
  maskedDocumentText?: string;      // Extracted + masked doc text
  hasImages: boolean;
  imageModelRequired: boolean;
  routingState: 'auto' | 'manual' | 'passthrough';
  manualModelId?: string;           // Set when routingState = 'manual'
  userId: string;
  piiDetected?: boolean;            // maskResult.entityCount > 0 — sovereignty gate signal
  conversationContext?: string;     // Kept for shape-compat; unused in Tahap 1
}

/**
 * The complete routing decision produced by the routing engine.
 * `routingReasonCode` + `flags` are the extensible seam (Phase-2 Tier-3 injection).
 */
export interface RoutingDecision {
  executedModelId: string;
  routingState: 'auto' | 'manual' | 'passthrough';
  complexityScore: number;          // Always 0 in auto after Tahap 1 (shape-compat)
  scoreBand: 'direct-answer' | 'moderate-reasoning' | 'advanced-reasoning';
  confidence: number;               // 0.0-1.0
  refinedPrompt: string;            // Original (PII-masked) prompt — no refinement in Tahap 1
  routingReasonCode: string;        // e.g. 'auto-fixed-model', 'auto-access-denied', 'passthrough'
  reasoningSummary: string;         // Human-readable summary
  modalityFlags: ModalityFlags;
  manualOverrideApplied: boolean;
  flags: string[];                  // e.g. ['auto-access-denied']
  skill: SkillType;                 // Always 'fallback'
  /** True if passthrough mode was active (no routing/refinement). */
  passthrough?: boolean;
  /** Detected language — shape-compat; Tahap 1 always 'indonesian'. */
  detectedLanguage?: string;
  /** Short routing summary for session row preview. */
  sessionContext?: string;

  // Routing decision timing (ms)
  routingDurationMs?: number;
}

/**
 * Input to the routing policy resolver for model selection.
 */
export interface PolicyInput {
  complexityScore: number;
  hasImages: boolean;
  isLongContext: boolean;
  routingState: 'auto' | 'manual' | 'passthrough';
  manualModelId?: string;
}

/**
 * Result from the routing policy indicating model selection and reason.
 */
export interface PolicyResult {
  modelId: string;
  reasonCode: string;
}
