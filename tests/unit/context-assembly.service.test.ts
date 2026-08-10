/**
 * Unit tests for the Context Assembly Service.
 * Tests token estimation, budget enforcement, truncation, and chronological ordering.
 *
 * @see Requirements 3.1, 3.2, 3.3, 3.5, 3.8, 4.1, 4.3
 */

import { describe, it, expect } from 'vitest';
import {
  assembleContext,
  estimateTokens,
  buildContext,
  buildKnowledgeSection,
} from '../../src/services/context-assembly.service.js';
import type {
  ContextConfig,
} from '../../src/services/context-assembly.service.js';
import type {
  StoredMessage,
  ContextAssemblyConfig,
} from '../../src/types/session.types.js';

function makeMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  createdAt?: string,
): StoredMessage {
  return {
    id,
    sessionId: 'session-1',
    role,
    sanitizedContent: content,
    createdAt: createdAt || new Date().toISOString(),
    storageFlags: { piiMasked: true },
  };
}

const defaultConfig: ContextAssemblyConfig = {
  tokenBudget: 200000,
  safetyMargin: 20000,
  summaryThreshold: 40,
  charsPerToken: 4,
};

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('', 4)).toBe(0);
  });

  it('returns Math.ceil(text.length / charsPerToken) for non-empty text', () => {
    expect(estimateTokens('hello', 4)).toBe(Math.ceil(5 / 4)); // 2
    expect(estimateTokens('abcd', 4)).toBe(1);
    expect(estimateTokens('abcde', 4)).toBe(2);
    expect(estimateTokens('a', 4)).toBe(1);
  });

  it('handles different charsPerToken values', () => {
    expect(estimateTokens('hello world', 2)).toBe(Math.ceil(11 / 2)); // 6
    expect(estimateTokens('hello world', 1)).toBe(11);
    expect(estimateTokens('hello world', 11)).toBe(1);
  });

  it('handles long text', () => {
    const longText = 'a'.repeat(1000);
    expect(estimateTokens(longText, 4)).toBe(250);
  });
});

describe('assembleContext', () => {
  it('returns empty context for empty history', () => {
    const result = assembleContext([], 'hello', defaultConfig);

    expect(result.messages).toHaveLength(0);
    expect(result.totalEstimatedTokens).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.truncatedCount).toBe(0);
    expect(result.summarized).toBe(false);
    expect(result.originalMessageCount).toBe(0);
  });

  it('includes a single message within budget', () => {
    const messages = [makeMessage('1', 'user', 'hello there')];
    const result = assembleContext(messages, 'current prompt', defaultConfig);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content[0].text).toBe('hello there');
    expect(result.totalEstimatedTokens).toBe(estimateTokens('hello there', 4));
    expect(result.truncated).toBe(false);
    expect(result.truncatedCount).toBe(0);
    expect(result.originalMessageCount).toBe(1);
  });

  it('includes multiple messages within budget in chronological order', () => {
    const messages = [
      makeMessage('1', 'user', 'first message', '2024-01-01T00:00:00Z'),
      makeMessage('2', 'assistant', 'first reply', '2024-01-01T00:01:00Z'),
      makeMessage('3', 'user', 'second message', '2024-01-01T00:02:00Z'),
      makeMessage('4', 'assistant', 'second reply', '2024-01-01T00:03:00Z'),
    ];

    const result = assembleContext(messages, 'current prompt', defaultConfig);

    expect(result.messages).toHaveLength(4);
    // Verify chronological order
    expect(result.messages[0].content[0].text).toBe('first message');
    expect(result.messages[1].content[0].text).toBe('first reply');
    expect(result.messages[2].content[0].text).toBe('second message');
    expect(result.messages[3].content[0].text).toBe('second reply');
    expect(result.truncated).toBe(false);
    expect(result.truncatedCount).toBe(0);
    expect(result.originalMessageCount).toBe(4);
  });

  it('truncates oldest messages when budget is exceeded', () => {
    // With charsPerToken=4, each char is 0.25 tokens
    // Set a tight budget: tokenBudget=100, safetyMargin=0
    const tightConfig: ContextAssemblyConfig = {
      tokenBudget: 100,
      safetyMargin: 0,
      summaryThreshold: 40,
      charsPerToken: 4,
    };

    // Each message is 400 chars = 100 tokens
    const longContent = 'a'.repeat(400);
    const messages = [
      makeMessage('1', 'user', longContent, '2024-01-01T00:00:00Z'),
      makeMessage('2', 'assistant', longContent, '2024-01-01T00:01:00Z'),
      makeMessage('3', 'user', 'short', '2024-01-01T00:02:00Z'), // 2 tokens
    ];

    // Current prompt is short; budget is 100 tokens
    // "prompt" = 6 chars / 4 = 2 tokens → history budget = 100 - 2 = 98 tokens
    // Most recent message (msg 3) = 2 tokens → fits, accumulated = 2
    // Next (msg 2) = 100 tokens → 2 + 100 = 102 > 98 → stop
    const result = assembleContext(messages, 'prompt', tightConfig);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content[0].text).toBe('short');
    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBe(2);
    expect(result.originalMessageCount).toBe(3);
  });

  it('safety margin is subtracted from budget', () => {
    // tokenBudget=50, safetyMargin=40 → available = 10 tokens for history + prompt
    const tightConfig: ContextAssemblyConfig = {
      tokenBudget: 50,
      safetyMargin: 40,
      summaryThreshold: 40,
      charsPerToken: 4,
    };

    // Current prompt: "hi" = 2 chars / 4 = 1 token → history budget = 10 - 1 = 9 tokens
    // Message: 40 chars = 10 tokens → exceeds 9 → dropped
    const messages = [makeMessage('1', 'user', 'a'.repeat(40))];
    const result = assembleContext(messages, 'hi', tightConfig);

    expect(result.messages).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBe(1);
  });

  it('returns empty messages when current prompt consumes entire budget', () => {
    const tightConfig: ContextAssemblyConfig = {
      tokenBudget: 100,
      safetyMargin: 50,
      summaryThreshold: 40,
      charsPerToken: 4,
    };

    // Available = 100 - 50 = 50 tokens
    // Current prompt: 200 chars = 50 tokens → history budget = 50 - 50 = 0
    const messages = [makeMessage('1', 'user', 'hello')];
    const result = assembleContext(messages, 'a'.repeat(200), tightConfig);

    expect(result.messages).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBe(1);
  });

  it('preserves correct BedrockMessage format', () => {
    const messages = [
      makeMessage('1', 'user', 'question one'),
      makeMessage('2', 'assistant', 'answer one'),
    ];
    const result = assembleContext(messages, 'current', defaultConfig);

    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [{ text: 'question one' }],
    });
    expect(result.messages[1]).toEqual({
      role: 'assistant',
      content: [{ text: 'answer one' }],
    });
  });

  it('sets summarized to false (MVP does not implement summary)', () => {
    const messages = Array.from({ length: 50 }, (_, i) =>
      makeMessage(`${i}`, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`)
    );
    const result = assembleContext(messages, 'current', defaultConfig);

    expect(result.summarized).toBe(false);
  });

  it('handles exactly-at-budget boundary', () => {
    // tokenBudget=10, safetyMargin=0, charsPerToken=4
    // current prompt: "hi" = 1 token → history budget = 10 - 1 = 9
    const config: ContextAssemblyConfig = {
      tokenBudget: 10,
      safetyMargin: 0,
      summaryThreshold: 40,
      charsPerToken: 4,
    };

    // Message: 36 chars = 9 tokens → exactly fits
    const messages = [makeMessage('1', 'user', 'a'.repeat(36))];
    const result = assembleContext(messages, 'hi', config);

    expect(result.messages).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(result.totalEstimatedTokens).toBe(9);
  });

  it('totalEstimatedTokens reflects only included messages', () => {
    const config: ContextAssemblyConfig = {
      tokenBudget: 20,
      safetyMargin: 0,
      summaryThreshold: 40,
      charsPerToken: 4,
    };

    // "current" = 7 chars / 4 = 2 tokens → history budget = 20 - 2 = 18
    // msg3: "ccc" (12 chars) = 3 tokens → accumulated = 3
    // msg2: "bbb" (12 chars) = 3 tokens → accumulated = 6
    // msg1: "aaa" (60 chars) = 15 tokens → 6 + 15 = 21 > 18 → stop
    const messages = [
      makeMessage('1', 'user', 'a'.repeat(60), '2024-01-01T00:00:00Z'),
      makeMessage('2', 'assistant', 'b'.repeat(12), '2024-01-01T00:01:00Z'),
      makeMessage('3', 'user', 'c'.repeat(12), '2024-01-01T00:02:00Z'),
    ];

    const result = assembleContext(messages, 'current', config);

    expect(result.messages).toHaveLength(2);
    expect(result.totalEstimatedTokens).toBe(6); // 3 + 3
    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBe(1);
  });
});

describe('buildContext', () => {
  const defaultCfg: ContextConfig = {
    maxHistoryMessages: 20,
    maxContextCharacters: 5000,
  };

  it('returns just current prompt when no history', () => {
    const result = buildContext([], 'hello world', defaultCfg);
    expect(result.inference_payload).toHaveLength(1);
    expect(result.inference_payload[0].role).toBe('user');
    expect(result.inference_payload[0].content[0].text).toBe('hello world');
    expect(result.evictedMessages).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(result.historyMessageCount).toBe(0);
  });

  it('includes all history within budget', () => {
    const history = [
      makeMessage('1', 'user', 'first'),
      makeMessage('2', 'assistant', 'reply'),
    ];
    const result = buildContext(history, 'current prompt', defaultCfg);
    expect(result.inference_payload).toHaveLength(3); // 2 history + current
    expect(result.inference_payload[0].content[0].text).toBe('first');
    expect(result.inference_payload[1].content[0].text).toBe('reply');
    expect(result.inference_payload[2].content[0].text).toBe('current prompt');
    expect(result.evictedMessages).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(result.historyMessageCount).toBe(2);
  });

  it('tracks evicted messages when over budget', () => {
    const tightCfg: ContextConfig = {
      maxHistoryMessages: 20,
      maxContextCharacters: 100, // tight budget
    };
    const history = [
      makeMessage('1', 'user', 'a'.repeat(80)),
      makeMessage('2', 'assistant', 'b'.repeat(80)),
      makeMessage('3', 'user', 'short'),
    ];
    const result = buildContext(history, 'hi', tightCfg);
    // Messages 1 and 2 (80 chars each) pushed out; msg 3 (5 chars) + current (2 chars) fit at 100? No, 5+2=7 < 100
    // Actually msg1 (80 chars) + msg2 (80 chars) + msg3 (5 chars) + current (2 chars) = 167 > 100
    // After dropping msg1: 80+5+2=87 < 100 ✓ → only msg1 evicted
    expect(result.evictedMessages).toHaveLength(1);
    expect(result.evictedMessages[0].id).toBe('1');
    expect(result.truncated).toBe(true);
    expect(result.historyMessageCount).toBe(2);
  });

  it('injects rolling summary into first history message when available', () => {
    const history = [
      makeMessage('1', 'user', 'original question'),
      makeMessage('2', 'assistant', 'original answer'),
    ];
    const cfgWithMemory: ContextConfig = {
      ...defaultCfg,
      memoryState: { summary: 'User asked about budgets. Budget set to 50M.' },
    };
    const result = buildContext(history, 'follow-up', cfgWithMemory);
    // First message should have summary prepended
    const firstMsg = result.inference_payload[0];
    expect(firstMsg.content[0].text).toContain('[Previous conversation summary:');
    expect(firstMsg.content[0].text).toContain('User asked about budgets');
    expect(firstMsg.content[0].text).toContain('original question');
    // Second message unchanged
    expect(result.inference_payload[1].content[0].text).toBe('original answer');
    // Current prompt is last
    expect(result.inference_payload[2].content[0].text).toBe('follow-up');
  });

  it('does not inject summary when there is no history', () => {
    const cfgWithMemory: ContextConfig = {
      ...defaultCfg,
      memoryState: { summary: 'Some old context.' },
    };
    const result = buildContext([], 'fresh start', cfgWithMemory);
    expect(result.inference_payload).toHaveLength(1);
    // Only the current prompt — no summary injection because there's no history message to inject into
    expect(result.inference_payload[0].content[0].text).toBe('fresh start');
  });

  it('builds routing_payload from last 2 user messages', () => {
    const history = [
      makeMessage('1', 'user', 'first question'),
      makeMessage('2', 'assistant', 'first answer'),
      makeMessage('3', 'user', 'second question'),
      makeMessage('4', 'assistant', 'second answer'),
    ];
    const result = buildContext(history, 'third question', defaultCfg);
    // routing_payload should contain last 2 user messages + last assistant response
    expect(result.routing_payload).toContain('first question');
    expect(result.routing_payload).toContain('second question');
    // Should include the last assistant response for context continuity
    expect(result.routing_payload).toContain('second answer');
    // Earlier messages not in the window
    expect(result.routing_payload).not.toContain('first answer');
  });

  it('handles summary injection alongside eviction', () => {
    const tightCfg: ContextConfig = {
      maxHistoryMessages: 20,
      maxContextCharacters: 200,
      memoryState: { summary: 'Early chat context.' },
    };
    const history = [
      makeMessage('1', 'user', 'a'.repeat(100)),
      makeMessage('2', 'assistant', 'b'.repeat(100)),
      makeMessage('3', 'user', 'what about X?'),
      makeMessage('4', 'assistant', 'X is handled.'),
    ];
    const result = buildContext(history, 'tell me more', tightCfg);
    // Budget 200: msg1(100) + msg2(100) + msg3(13) + msg4(14) + current(12) = 239 > 200
    // Drop msg1: 100+13+14+12 = 139 < 200 ✓
    expect(result.evictedMessages).toHaveLength(1);
    expect(result.evictedMessages[0].id).toBe('1');
    // Summary injected into what is now the first message (msg2)
    expect(result.inference_payload[0].content[0].text).toContain('[Previous conversation summary:');
    expect(result.inference_payload[0].content[0].text).toContain('Early chat context');
    expect(result.inference_payload[0].role).toBe('assistant');
  });

  it('injects extracted facts alongside summary', () => {
    const history = [
      makeMessage('1', 'user', 'set budget to 50M'),
      makeMessage('2', 'assistant', 'Budget set to 50M IDR.'),
    ];
    const cfgWithFacts: ContextConfig = {
      ...defaultCfg,
      memoryState: {
        summary: 'User set budget to 50M.',
        facts: { budget: '50M IDR', deadline: 'Q3 2026' },
      },
    };
    const result = buildContext(history, 'follow-up', cfgWithFacts);
    const firstMsg = result.inference_payload[0].content[0].text;
    expect(firstMsg).toContain('[Previous conversation summary:');
    expect(firstMsg).toContain('User set budget to 50M.');
    expect(firstMsg).toContain('[Extracted facts:');
    expect(firstMsg).toContain('budget=50M IDR');
    expect(firstMsg).toContain('deadline=Q3 2026');
    expect(firstMsg).toContain('set budget to 50M');
  });

  it('injects facts without summary when summary is null', () => {
    const history = [
      makeMessage('1', 'user', 'deadline is Sep 30'),
      makeMessage('2', 'assistant', 'Noted.'),
    ];
    const cfgFactsOnly: ContextConfig = {
      ...defaultCfg,
      memoryState: {
        summary: null,
        facts: { deadline: 'Sep 30' },
      },
    };
    const result = buildContext(history, 'thanks', cfgFactsOnly);
    const firstMsg = result.inference_payload[0].content[0].text;
    expect(firstMsg).toContain('[Extracted facts:');
    expect(firstMsg).toContain('deadline=Sep 30');
    expect(firstMsg).not.toContain('Previous conversation summary');
  });
});

describe('buildKnowledgeSection', () => {
  const chunk = (over: Partial<{ id: string; title: string; content: string; docType: string }>) => ({
    id: over.id ?? 'c1',
    title: over.title ?? 'SOP Pengajuan Kredit',
    content: over.content ?? 'Nasabah mengisi formulir pengajuan.',
    docType: over.docType ?? 'SOP',
    score: 0.82,
    bindingLevel: 'regulatory',
    sourceType: 'internal',
    metadata: null,
  });

  it('returns empty string for no chunks (injection is a no-op)', () => {
    expect(buildKnowledgeSection([])).toBe('');
  });

  it('wraps chunks with [Sumber: {title}] and adds citation rule', () => {
    const section = buildKnowledgeSection([chunk({})]);
    expect(section).toContain('[Reference documents]');
    expect(section).toContain('[Sumber: SOP Pengajuan Kredit]');
    expect(section).toContain('Nasabah mengisi formulir pengajuan.');
    expect(section).toContain('cite as [Sumber: {title}, {section}]');
  });

  it('separates multiple chunks and preserves ordering', () => {
    const section = buildKnowledgeSection([chunk({}), chunk({ title: 'MEMO Data', content: 'Retensi 5 tahun.' })]);
    const idxFirst = section.indexOf('[Sumber: SOP Pengajuan Kredit]');
    const idxSecond = section.indexOf('[Sumber: MEMO Data]');
    expect(idxFirst).toBeGreaterThan(-1);
    expect(idxSecond).toBeGreaterThan(idxFirst);
  });
});
