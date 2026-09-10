/**
 * Routing Engine Service
 *
 * Sovereign-tier routing (Phase 2): Auto mode runs a deterministic sovereignty gate
 * (PII or admin restricted-word → restricted/private, reason 'auto-tier-1') then picks a
 * single fixed Bedrock model (config.routing.autoModelId, or tier1ModelId when restricted)
 * with ZERO LLM routing calls. When the Tier-3 external gateway is enabled and the request
 * is open + text-only with an enabled default model, the decision is flagged 'tier3-candidate'
 * — final escalation to the external model happens post-retrieval in the handler (T3 never
 * sees internal knowledge text). Manual and passthrough branches are preserved byte-for-byte
 * where observable (raw prompt, fallback role/format). Sequential reasoning is gone.
 */

import { config } from '../config/index.js';
import { resolvePolicy } from './routing-policy.service.js';
import type {
  RoutingInput,
  RoutingDecision,
  PolicyInput,
} from '../types/routing.types.js';
import type { ModalityFlags } from '../types/inference.types.js';
import { DEFAULT_MODEL } from '../types/inference.types.js';
import { checkModelAccess } from './inference.service.js';
import { getDefaultTier3Model } from './tier3.service.js';
import { getRestrictedTerms } from './restricted-terms.service.js';

export interface AutoModelContext {
  userId: string;
  hasImages: boolean;
  /** Masked original prompt — restricted-signal source for the sovereignty gate. */
  prompt: string;
  piiDetected?: boolean;
  /** Masked doc text (multipart / WGS fetch / sticky session doc). Undefined for plain text; blocks Tier-3 candidate. */
  documentText?: string;
  /** The doc text came from the session's sticky internal document (earlier WGS fetch). */
  documentTextFromSession?: boolean;
}

export interface AutoModelSelection {
  modelId: string;
  reasonCode: string; // 'auto-fixed-model' | 'auto-access-denied' | 'auto-tier-1'
  flags: string[];
}

export interface SovereignTierInput {
  prompt: string;
  piiDetected?: boolean;
  documentText?: string;
}

/**
 * Deterministic sovereignty classifier — restricted means "private only, never external".
 * PII detected OR an admin restricted-word hit (case-insensitive substring of the masked
 * prompt/doc text). Degrades to PII-only when the terms DB/cache is unavailable.
 * Zero LLM calls. T3 is caller escalation only — restricted never reaches it.
 */
export async function classifySovereignTier(input: SovereignTierInput): Promise<boolean> {
  if (input.piiDetected === true) return true;
  const terms = await getRestrictedTerms();
  if (terms.length === 0) return false;
  const hay = `${input.prompt ?? ''} ${input.documentText ?? ''}`.toLowerCase();
  return terms.some((t) => hay.includes(t.toLowerCase()));
}

/**
 * Deterministic model selection for Auto mode — zero LLM routing calls.
 * Restricted (PII/lexicon) → private Bedrock tier1ModelId, reason 'auto-tier-1'.
 * Open → autoModelId ('auto-fixed-model', byte-identical to Tahap 1); when the Tier-3
 * gateway is enabled + text-only + an enabled default model exists, flag 'tier3-candidate'
 * (provisional — final external escalation is resolved post-retrieval in the handler).
 */
export async function selectAutoModel(ctx: AutoModelContext): Promise<AutoModelSelection> {
  const restricted = await classifySovereignTier({
    prompt: ctx.prompt,
    piiDetected: ctx.piiDetected,
    documentText: ctx.documentText,
  });

  if (restricted) {
    const modelId = config.routing.tier1ModelId || config.routing.autoModelId;
    if (!(await checkModelAccess(ctx.userId, modelId))) {
      return {
        modelId: DEFAULT_MODEL,
        reasonCode: 'auto-access-denied',
        flags: ['auto-access-denied', 'sovereign-tier-1'],
      };
    }
    return { modelId, reasonCode: 'auto-tier-1', flags: ['sovereign-tier-1'] };
  }

  const modelId = config.routing.autoModelId;
  if (!(await checkModelAccess(ctx.userId, modelId))) {
    return { modelId: DEFAULT_MODEL, reasonCode: 'auto-access-denied', flags: ['auto-access-denied'] };
  }

  const flags: string[] = [];
  // A Google Workspace document (this turn or earlier in the session) is internal material:
  // it blocks the Tier-3 candidate so the conversation stays on private Bedrock.
  if (ctx.documentText && ctx.documentTextFromSession) flags.push('sovereign-internal-document');
  if (config.routing.externalTier3.enabled && !ctx.hasImages && !ctx.documentText) {
    const tier3Default = await getDefaultTier3Model();
    if (tier3Default) flags.push('tier3-candidate');
  }
  return { modelId, reasonCode: 'auto-fixed-model', flags };
}

/**
 * Maps a complexity score to its band name.
 * Retained for RoutingDecision shape-compat — auto always scores 0.
 */
function scoreToBand(score: number): 'direct-answer' | 'moderate-reasoning' | 'advanced-reasoning' {
  if (score <= 1) return 'direct-answer';
  if (score <= 3) return 'moderate-reasoning';
  return 'advanced-reasoning';
}

/**
 * Builds modality flags from routing input.
 */
function buildModalityFlags(input: RoutingInput): ModalityFlags {
  const hasDocument = !!input.maskedDocumentText;
  const hasImage = input.hasImages;

  return {
    textOnly: !hasDocument && !hasImage,
    documentText: hasDocument && !hasImage,
    image: hasImage && !hasDocument,
    mixed: hasDocument && hasImage,
  };
}

/**
 * Determines the modality description for the reasoning summary.
 */
function getModalityDescription(flags: ModalityFlags): string {
  if (flags.mixed) return 'mixed modality';
  if (flags.image) return 'image modality';
  if (flags.documentText) return 'document-text modality';
  return 'text-only modality';
}

/**
 * Main entry point for the routing engine.
 */
export async function routeRequest(input: RoutingInput): Promise<RoutingDecision> {
  const modalityFlags = buildModalityFlags(input);
  const flags: string[] = [];

  // Manual state: skip refinement/scoring, use policy with manual state
  if (input.routingState === 'manual') {
    const policyInput: PolicyInput = {
      complexityScore: config.routing.defaultFallbackScore,
      hasImages: input.hasImages,
      isLongContext: false,
      routingState: 'manual',
      manualModelId: input.manualModelId,
    };

    let policyResult;
    try {
      policyResult = resolvePolicy(policyInput);
    } catch {
      policyResult = { modelId: 'qwen.qwen3-32b-v1:0', reasonCode: 'routing-fallback' };
      flags.push('policy-failed');
    }

    return {
      executedModelId: policyResult.modelId,
      routingState: 'manual',
      complexityScore: config.routing.defaultFallbackScore,
      scoreBand: scoreToBand(config.routing.defaultFallbackScore),
      confidence: 1.0,
      refinedPrompt: input.originalPrompt,
      routingReasonCode: policyResult.reasonCode,
      reasoningSummary: `Manual routing: user selected model ${policyResult.modelId}, ${getModalityDescription(modalityFlags)}`,
      modalityFlags,
      manualOverrideApplied: true,
      flags,
      skill: 'fallback',
      sessionContext: undefined,
    };
  }

  // Passthrough state: skip all routing, use minimal system prompt
  if (input.routingState === 'passthrough') {
    const modelId = input.manualModelId || 'qwen.qwen3-32b-v1:0';
    return {
      executedModelId: modelId,
      routingState: 'passthrough',
      complexityScore: config.routing.defaultFallbackScore,
      scoreBand: scoreToBand(config.routing.defaultFallbackScore),
      confidence: 1.0,
      refinedPrompt: input.originalPrompt,
      routingReasonCode: 'passthrough',
      reasoningSummary: `Passthrough mode — raw prompt, no routing`,
      modalityFlags,
      manualOverrideApplied: false,
      passthrough: true,
      flags: ['passthrough'],
      skill: 'fallback',
      sessionContext: input.originalPrompt.slice(0, 120), // first 120 chars as preview
    };
  }

  // Auto state: deterministic fixed-model routing — zero LLM routing calls.
  const routingStart = Date.now();
  const selection = await selectAutoModel({
    userId: input.userId,
    hasImages: input.hasImages,
    prompt: input.originalPrompt,
    piiDetected: input.piiDetected,
    documentText: input.maskedDocumentText,
    documentTextFromSession: input.documentTextFromSession,
  });

  return {
    executedModelId: selection.modelId,
    routingState: 'auto',
    complexityScore: 0,
    scoreBand: scoreToBand(0),
    confidence: 1.0,
    refinedPrompt: input.originalPrompt,  // raw — no refinement
    routingReasonCode: selection.reasonCode,
    reasoningSummary: `Auto routing: fixed model ${selection.modelId} (${selection.reasonCode})`,
    modalityFlags,
    manualOverrideApplied: false,
    flags: selection.flags,
    skill: 'fallback',
    sessionContext: input.originalPrompt.slice(0, 120),
    routingDurationMs: Date.now() - routingStart,
  };
}
