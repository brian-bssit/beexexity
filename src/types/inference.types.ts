/**
 * Inference service types and model constants.
 * @see Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3
 */

import type { ContentBlock } from './upload.types.js';

export interface InferenceRequest {
  maskedPrompt: string;
  modelId: string;
  userId: string;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  };
  contentBlocks?: ContentBlock[];
}

export interface MultimodalInferenceRequest {
  contentBlocks: ContentBlock[];
  modelId: string;
  userId: string;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  };
}

export interface InferenceResult {
  status: 'success' | 'failed';
  inputTokens: number;
  outputTokens: number;
  modelId: string;
  errorCategory?: 'throttling' | 'timeout' | 'model_error' | 'unknown';
}

export const ALLOWED_MODELS = [
  'amazon.nova-lite-v1:0',
  'anthropic.claude-sonnet-5',
  'openai.gpt-oss-120b-1:0',
  'qwen.qwen3-235b-a22b-2507-v1:0',
  'qwen.qwen3-32b-v1:0',
  'zai.glm-5',
  'deepseek.v3.2',
] as const;

export type AllowedModelId = typeof ALLOWED_MODELS[number];

export const DEFAULT_MODEL: AllowedModelId = 'qwen.qwen3-32b-v1:0';

export interface ModalityFlags {
  textOnly: boolean;
  documentText: boolean;
  image: boolean;
  mixed: boolean;
}

export interface RoutingMetadataEvent {
  routingState: 'auto' | 'manual' | 'passthrough';
  executedModelId: string;
  routingReasonCode: string;        // e.g. 'auto-fixed-model' | 'auto-access-denied' | 'passthrough'
  modalityFlags?: ModalityFlags;
  manualOverrideApplied: boolean;
  flags?: string[];

  // Routing decision timing (ms)
  routingDurationMs?: number;

  // Prompt info
  originalPromptLength?: number;
  promptLengthAfterRefinement?: number;

  // Conversation context
  conversationContext?: string;  // routing_payload sent to routing engine
  historyMessageCount?: number;
  contextTruncated?: boolean;

  // Session memory state
  memorySummary?: string;
  memoryVersion?: number;
  /** Structured key-value facts extracted from conversation */
  memoryFacts?: Record<string, string>;

  // Two-stage OCR info (multipart only)
  ocrExecuted?: boolean;
  ocrModel?: string;
  enhanceModel?: string;
}
