/**
 * Context Assembly Service
 * Selects which stored messages to include in a Bedrock ConverseStream request,
 * respecting configurable character budgets using a sliding-window strategy.
 *
 * This is a pure function with no database calls — it operates on pre-fetched
 * session messages and returns an assembled context window.
 *
 * @see Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.1, 4.2, 4.3
 */

import type {
  StoredMessage,
  ContextAssemblyConfig,
  AssembledContext,
  BedrockMessage,
} from '../types/session.types.js';
import type { KnowledgeChunk } from '../types/knowledge.types.js';

// ─── New Interfaces ────────────────────────────────────────────────────────────

/**
 * Configuration for the unified context builder.
 */
export interface ContextConfig {
  /** Maximum number of history messages to include (default: 20 = 10 turns) */
  maxHistoryMessages: number;
  /** Maximum total character count for history + current prompt (default: 120,000) */
  maxContextCharacters: number;
  /** Optional system prompt to prepend to inference_payload */
  systemPrompt?: string;
  /** Session memory state for rolling summary + facts injection into context */
  memoryState?: { summary: string | null; facts?: Record<string, string> };
}

/**
 * Output from the unified context builder.
 */
export interface ContextOutput {
  /** Full message array for Bedrock ConverseStream (history + current user prompt) */
  inference_payload: BedrockMessage[];
  /** Condensed payload for routing engine (last 2 user messages from history, max 500 chars) */
  routing_payload: string | undefined;
  /** Whether oldest messages were dropped to fit character budget */
  truncated: boolean;
  /** Number of history messages included */
  historyMessageCount: number;
  /** Messages that were evicted from the window to fit the budget — candidates for summary refresh */
  evictedMessages: StoredMessage[];
}

// ─── Error Classes ─────────────────────────────────────────────────────────────

/**
 * Thrown when the current prompt alone exceeds maxContextCharacters.
 * This prevents an impossible-to-satisfy budget loop.
 */
export class PromptTooLargeError extends Error {
  constructor(promptLength: number, maxChars: number) {
    super(
      `Prompt length (${promptLength}) exceeds maximum allowed characters (${maxChars}).`,
    );
    this.name = 'PromptTooLargeError';
  }
}

// ─── Unified Context Builder ───────────────────────────────────────────────────

/**
 * Build context from session messages using a sliding window.
 *
 * Algorithm:
 * 1. GUARD: If currentPrompt.length > maxContextCharacters, throw PromptTooLargeError
 * 2. Take the most recent N messages from sessionMessages (default: 20 = 10 turns)
 * 3. If total character count of (history + currentPrompt) exceeds maxContextCharacters,
 *    drop the oldest history messages one-by-one until it fits
 * 4. Format as BedrockMessage array: history messages + current user prompt
 * 5. Extract routing_payload: from the selected history messages (NOT from inference_payload),
 *    filter to role==='user' only, take last 2, concatenate their content, cap at 500 chars.
 *    The system prompt is NEVER included in routing_payload. Return undefined if no prior
 *    user messages exist in the selected history.
 *
 * @param sessionMessages - All stored messages for the session, ordered chronologically (ASC)
 * @param currentPrompt - The current user prompt (included in inference_payload as final message)
 * @param config - Context configuration
 * @returns ContextOutput with inference_payload, routing_payload, and metadata
 * @throws PromptTooLargeError if currentPrompt alone exceeds maxContextCharacters
 */
export function buildContext(
  sessionMessages: StoredMessage[],
  currentPrompt: string,
  config: ContextConfig,
): ContextOutput {
  // Step 1: GUARD — reject prompts that alone exceed the character budget
  if (currentPrompt.length > config.maxContextCharacters) {
    throw new PromptTooLargeError(currentPrompt.length, config.maxContextCharacters);
  }

  // Step 2: Take the most recent N messages (sliding window)
  const windowedMessages = sessionMessages.slice(-config.maxHistoryMessages);
  const originalWindowCount = windowedMessages.length;

  // Step 3: Drop oldest messages one-by-one if total chars exceed budget.
  // Evicted messages are tracked for potential summary refresh.
  const evictedMessages: StoredMessage[] = [];
  const historyMessages = [...windowedMessages];
  while (historyMessages.length > 0) {
    const totalChars =
      historyMessages.reduce((sum, msg) => sum + msg.sanitizedContent.length, 0) +
      currentPrompt.length;
    if (totalChars <= config.maxContextCharacters) {
      break;
    }
    // Drop the oldest message — capture for summary
    const evicted = historyMessages.shift();
    if (evicted) evictedMessages.push(evicted);
  }

  const truncated = historyMessages.length < originalWindowCount;

  // Step 4: Build inference_payload — history messages + current user prompt.
  // If a rolling summary exists, inject it into the first history message's text
  // so the model has context about older conversation turns.
  const inferencePayload: BedrockMessage[] = historyMessages.map((msg) => ({
    role: msg.role,
    content: [{ text: msg.sanitizedContent }],
  }));

  // Inject rolling summary + extracted facts into the first history message (if available)
  if (inferencePayload.length > 0) {
    const memoryParts: string[] = [];
    if (config.memoryState?.summary) {
      memoryParts.push(`[Previous conversation summary: ${config.memoryState.summary}]`);
    }
    const facts = config.memoryState?.facts;
    if (facts && Object.keys(facts).length > 0) {
      const factList = Object.entries(facts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      memoryParts.push(`[Extracted facts: ${factList}]`);
    }
    if (memoryParts.length > 0) {
      const firstMsg = inferencePayload[0];
      firstMsg.content[0].text = `${memoryParts.join('\n')}\n\n${firstMsg.content[0].text}`;
    }
  }

  // Append current user prompt as the final message
  inferencePayload.push({
    role: 'user',
    content: [{ text: currentPrompt }],
  });

  // Step 5: Build routing_payload from selected history — includes last 2 user
  // messages AND last 1 assistant message so the refinement LLM can connect
  // follow-up prompts (e.g. "make it in english" → knows previous response was in French).
  const userHistoryMessages = historyMessages.filter((msg) => msg.role === 'user');
  const assistantHistoryMessages = historyMessages.filter((msg) => msg.role === 'assistant');
  let routingPayload: string | undefined = undefined;

  if (userHistoryMessages.length > 0) {
    const lastTwoUserMessages = userHistoryMessages.slice(-2);
    const userText = lastTwoUserMessages
      .map((msg) => msg.sanitizedContent)
      .join(' ');

    // Include last assistant response for context continuity
    let assistantText = '';
    if (assistantHistoryMessages.length > 0) {
      const lastAssistant = assistantHistoryMessages[assistantHistoryMessages.length - 1];
      assistantText = ` [Assistant: ${lastAssistant.sanitizedContent}]`;
    }

    const concatenated = `${userText}${assistantText}`;
    // Strip newlines — routing_payload flows into SSE event JSON, and the
    // frontend SSE parser splits on \n. Newlines also add noise for the routing LLM.
    routingPayload = concatenated.replace(/[\r\n]+/g, ' ').slice(0, 500);
  }

  return {
    inference_payload: inferencePayload,
    routing_payload: routingPayload,
    truncated,
    historyMessageCount: historyMessages.length,
    evictedMessages,
  };
}

// ─── Knowledge Injection (Tier 2) ──────────────────────────────────────────────

/**
 * Format retrieved knowledge chunks into a system-prompt section with a citation rule.
 * Empty array → empty string (injection is a no-op when no knowledge was retrieved).
 *
 * @param chunks - Retrieved knowledge chunks, best-ranked first
 * @returns Markdown section to append to the system prompt, or '' if empty
 */
export function buildKnowledgeSection(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) return '';

  const blocks = chunks
    .map((c) => `[Sumber: ${c.title}]\n${c.content}`)
    .join('\n\n');

  return [
    '[Reference documents]',
    blocks,
    'If you use information from reference documents, cite as [Sumber: {title}, {section}].',
  ].join('\n\n');
}

// ─── Legacy Functions (kept for backwards compatibility) ───────────────────────

/**
 * Estimate the number of tokens in a text string using a character-based approximation.
 *
 * This is documented as an approximation — not an exact provider tokenizer guarantee.
 * The formula is: Math.ceil(text.length / charsPerToken)
 *
 * @param text - The text to estimate tokens for
 * @param charsPerToken - The character-to-token ratio (default: 4)
 * @returns Estimated token count (always >= 1 for non-empty text, 0 for empty text)
 * @deprecated No longer used internally — kept for backwards compatibility
 */
export function estimateTokens(text: string, charsPerToken: number): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Convert a StoredMessage to a BedrockMessage format.
 */
function toBedrockMessage(msg: StoredMessage): BedrockMessage {
  return {
    role: msg.role,
    content: [{ text: msg.sanitizedContent }],
  };
}

/**
 * Assemble a context window from stored session messages within a token budget.
 *
 * @deprecated Use `buildContext()` instead — this function is kept for backwards compatibility.
 *
 * @param sessionMessages - All stored messages for the session, ordered chronologically (ASC)
 * @param currentPrompt - The current user prompt (used for budget estimation but not included in output)
 * @param config - Token budget configuration
 * @returns AssembledContext with selected messages and metadata
 */
export function assembleContext(
  sessionMessages: StoredMessage[],
  currentPrompt: string,
  config: ContextAssemblyConfig,
): AssembledContext {
  const originalMessageCount = sessionMessages.length;

  // Empty history — nothing to assemble
  if (sessionMessages.length === 0) {
    return {
      messages: [],
      totalEstimatedTokens: 0,
      truncated: false,
      truncatedCount: 0,
      summarized: false,
      originalMessageCount: 0,
    };
  }

  // Step 1: Calculate available budget
  const availableBudget = config.tokenBudget - config.safetyMargin;
  const currentPromptTokens = estimateTokens(currentPrompt, config.charsPerToken);
  const historyBudget = availableBudget - currentPromptTokens;

  // If there's no room for history at all, return empty
  if (historyBudget <= 0) {
    return {
      messages: [],
      totalEstimatedTokens: 0,
      truncated: originalMessageCount > 0,
      truncatedCount: originalMessageCount,
      summarized: false,
      originalMessageCount,
    };
  }

  // Step 2-3: Accumulate messages from most-recent backwards
  const selectedMessages: StoredMessage[] = [];
  let accumulatedTokens = 0;

  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    const msg = sessionMessages[i];
    const msgTokens = estimateTokens(msg.sanitizedContent, config.charsPerToken);

    if (accumulatedTokens + msgTokens > historyBudget) {
      break;
    }

    accumulatedTokens += msgTokens;
    selectedMessages.push(msg);
  }

  // Step 5: Re-order chronologically
  selectedMessages.reverse();

  // Step 6: Convert to BedrockMessage format
  const bedrockMessages: BedrockMessage[] = selectedMessages.map(toBedrockMessage);

  const truncatedCount = originalMessageCount - selectedMessages.length;

  return {
    messages: bedrockMessages,
    totalEstimatedTokens: accumulatedTokens,
    truncated: truncatedCount > 0,
    truncatedCount,
    summarized: false,
    originalMessageCount,
  };
}
