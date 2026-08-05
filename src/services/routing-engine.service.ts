/**
 * Routing Engine Service
 *
 * Performs prompt refinement, complexity scoring, and policy-based routing.
 * Uses qwen.qwen3-32b-v1:0 via Bedrock Converse (non-streaming) for both
 * refinement and scoring operations.
 *
 * Fallback strategy:
 * - Refinement failure → use original prompt + 'refinement-failed' flag
 * - Scoring failure → default score from config (2)
 * - Policy failure → fallback to qwen.qwen3-32b-v1:0
 *
 * @see Requirements 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.5, 6.1, 6.2, 6.3, 10.1, 10.2, 12.1, 12.2, 12.3, 12.4
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config/index.js';
import { resolvePolicy } from './routing-policy.service.js';
import type {
  RoutingInput,
  RoutingDecision,
  PolicyInput,
} from '../types/routing.types.js';
import { SkillType, ALL_SKILLS } from '../types/routing.types.js';
import type { PromptContract, VerificationResult } from '../types/routing.types.js';
import type { ModalityFlags } from '../types/inference.types.js';
import { getRoleForSkill } from '../config/skill-role-map.js';
import { query } from '../config/database.js';

/** Bedrock client for routing engine calls (scoring + refinement). */
const bedrockClient = new BedrockRuntimeClient({
  region: config.aws.region,
});

/**
 * Parses a JSON response from the refinement model and returns both a flowing
 * text prompt (backward compat) and a structured contract (for verification).
 * Handles markdown-wrapped JSON (```json ... ```).
 * Returns null flowingText if the response cannot be parsed.
 */
function parseRefinementContract(raw: string): {
  flowingText: string | null;
  contract: PromptContract | null;
} {
  let jsonStr = raw.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { flowingText: null, contract: null };
  }

  const role = typeof parsed.role === 'string' ? parsed.role.trim() : '';
  const context = typeof parsed.context === 'string' ? parsed.context.trim() : '';
  const task = typeof parsed.task === 'string' ? parsed.task.trim() : '';
  const intent = typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
  const ambiguities = Array.isArray(parsed.ambiguities)
    ? parsed.ambiguities.filter((a): a is string => typeof a === 'string')
    : [];
  const clarificationNeeded = parsed.clarification_needed === true || (Array.isArray(parsed.ambiguities) && parsed.ambiguities.length > 0);
  const behavioral_instructions = typeof parsed.behavioral_instructions === 'string'
    ? parsed.behavioral_instructions.trim()
    : undefined;
  const output_format = typeof parsed.output_format === 'string'
    ? parsed.output_format.trim()
    : undefined;

  const parts: string[] = [];
  if (task) parts.push(task);
  if (context && task) parts.push('\n\n---\n' + context);
  else if (context) parts.push(context);
  if (role && task) parts.push('\n\nRole: ' + role);
  else if (role) parts.push(role);
  if (behavioral_instructions) parts.push('\n\nGuidelines:\n' + behavioral_instructions);
  if (output_format) parts.push('\n\nFormat:\n' + output_format);
  const flowingText = parts.length > 0 ? parts.join('') : null;

  const contract: PromptContract = {
    role, context, task, intent, ambiguities, clarificationNeeded,
    behavioral_instructions, output_format,
  };

  if (typeof parsed.format === 'object' && parsed.format !== null) {
    const fmt = parsed.format as Record<string, unknown>;
    if (typeof fmt.type === 'string') {
      contract.format = { type: fmt.type };
      if (Array.isArray(fmt.mustInclude)) {
        contract.format.mustInclude = fmt.mustInclude.filter((s): s is string => typeof s === 'string');
      }
      if (Array.isArray(fmt.mustAvoid)) {
        contract.format.mustAvoid = fmt.mustAvoid.filter((s): s is string => typeof s === 'string');
      }
    }
  }
  if (Array.isArray(parsed.constraints)) {
    contract.constraints = parsed.constraints.filter((c): c is string => typeof c === 'string');
  }

  return { flowingText, contract };
}

/**
 * Extracts a skill tag from raw classifier output via substring match across
 * all skills. Returns 'fallback' if nothing matches.
 */
function extractSkill(raw: string): SkillType {
  const lower = raw.toLowerCase().trim();
  for (const skill of ALL_SKILLS) {
    if (lower.includes(skill)) return skill;
  }
  return 'fallback';
}

/**
 * Global rules prepended to ALL skill refinement prompts.
 */
const GLOBAL_REFINEMENT_RULES = [
  '### CRITICAL: Scope Control',
  'Match the response depth to the user\'s prompt length and specificity.',
  'A short, general question ("tell me about X") should get a concise answer,',
  'not a comprehensive essay. Do NOT expand scope beyond what the user asked.',
  'The INTENT field must reflect the ACTUAL question scope, not an expanded version.',
  'Examples:',
  '  - Prompt: "kamu tahu apa tentang k8s?" → intent: "answer concisely about k8s"',
  '  - Prompt: "Explain Kubernetes architecture with component diagram" → intent: "detailed explanation"',
  '  - Prompt: "evaluasi dokumen ini" → intent: "evaluate the uploaded document"',
  '',
  '### DYNAMIC INSTRUCTION GENERATION (Turn 1 only)',
  'Based on the user\'s task, skill, and document context, generate specific guidance for the inference model.',
  '1. "behavioral_instructions": Specific criteria, focus areas, or behavioral rules the model must follow (e.g., "Focus on security and scalability", "Use formal tone", "Prioritize SOLID principles") in the user\'s language.',
  '2. "output_format": How the final response should be structured (e.g., "Use a 3-bullet list", "Format as a professional report with headings: Executive Summary, Strengths, Risks, Recommendations") in the user\'s language.',
  '3. CRITICAL: Both fields MUST be in the EXACT SAME LANGUAGE as the user\'s original prompt. NEVER use English if the user wrote in Indonesian.',
  '4. For simple tasks (e.g., basic translation, greetings), you may omit these fields.',
].join('\n');
/**
 * Lighter refinement prompt for follow-up queries (turn 2+).
 * Role and context are already established in conversation history.
 * The LLM still receives conversationContext as input (for resolving references),
 * but the output JSON omits role/context to avoid redundant English framing
 * that can bias the inference model's language.
 */
const SKILL_REFINEMENT_PROMPT = [
  'You are an expert prompt engineer refining a user\'s request for an AI inference engine.',
  'The user\'s detected skill is: {{skill}}.',
  'The user\'s detected language is: {{detected_language}}.',
  '',
  '### CRITICAL INSTRUCTIONS',
  '1. TASK FIELD: Copy user\'s EXACT original prompt VERBATIM. Do not translate or alter.',
  '2. LANGUAGE PRESERVATION: The "context", "intent", "behavioral_instructions", and "output_format" fields MUST be written in the EXACT SAME LANGUAGE as the user\'s original prompt ({{detected_language}}). NEVER use English if the user wrote in Indonesian.',
  '3. DYNAMIC FIELDS: Based on the task and skill, generate specific guidance for the final model.',
  '   - "behavioral_instructions": Specific criteria, focus areas, or behavioral rules (e.g., "Fokus pada keamanan dan skalabilitas").',
  '   - "behavioral_instructions": Specific criteria, focus areas, or behavioral rules to guide the inference model (e.g., "Fokus pada keamanan dan skalabilitas").',
  '4. BE CONCISE. High signal, zero noise.',
  '5. JSON ONLY. No markdown, no explanations.',
  '',
  '### OUTPUT FORMAT',
  '{',
  '  "role": "<expert role appropriate for the {{skill}} skill, e.g. Cloud Security Engineer, Compliance Officer, Tax Consultant>",',
  '  "context": "<brief context description in user\'s language>",',
  '  "task": "<EXACT VERBATIM USER PROMPT>",',
  '  "intent": "<what the user wants to achieve, in user\'s language>",',
  '  "behavioral_instructions": "<dynamic guidance in user\'s language>",',
  '  "ambiguities": ["<list missing info in user\'s language>"],',
  '  "clarification_needed": false',
  '}',
].join('\n');

const FOLLOW_UP_REFINEMENT_PROMPT = [
  'You are a prompt refiner for FOLLOW-UP questions in an ongoing conversation.',
  'The user\'s role and context are already established — do NOT re-introduce them.',
  '',
  '### CRITICAL: Language & Scope',
  '1. LANGUAGE PRESERVATION: Output values in the EXACT SAME language as the input.',
  '2. BE CONCISE. The user is continuing a conversation — don\'t expand scope.',
  '3. JSON ONLY. No markdown, no explanations.',
  '',
  '### DYNAMIC INSTRUCTION GENERATION',
  'Based on the user\'s follow-up and conversation history, generate specific guidance for the inference model.',
  '1. "behavioral_instructions": Specific focus areas or behavioral rules the model must follow (e.g., "Focus on security and scalability", "Use formal tone").',
  '2. "output_format": OBSOLETE — do NOT generate this field. Output format is handled by deterministic templates.',
  '3. CRITICAL: Both fields MUST be in the EXACT SAME LANGUAGE as the user\'s follow-up. NEVER use English if the user wrote in Indonesian.',
  '4. For simple tasks (e.g., greetings, basic translation), you may omit these fields.',
  '',
  'Output JSON with these fields ONLY (no role, no context):',
  '{',
  '  "task": "User\'s original follow-up prompt VERBATIM in original language",',
  '  "intent": "What this specific follow-up wants to accomplish",',
  '  "behavioral_instructions": "Specific guidance in user\'s language (optional)",',

  '  "ambiguities": ["What is unclear (if anything)"],',
  '  "clarification_needed": false',
  '}',
].join('\n');

export async function refinePrompt(
  originalPrompt: string,
  documentContext?: string,
  skill: SkillType = 'fallback',
  conversationContext?: string,
  detectedLanguage?: string,
): Promise<{ flowingText: string | null; contract: PromptContract | null; _rawResponse?: string; _rawPrompt?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, config.routing.refinementTimeoutMs);

  try {
    // Use a lighter refinement prompt for follow-ups (turn 2+) — role/context
    // are already established in conversation history. The LLM still receives
    // conversationContext as input for understanding, but omits role/context
    // from the output JSON to avoid redundant framing that can bias language.
    const isFollowUp = !!(conversationContext && conversationContext.trim().length > 0);
    let systemPrompt: string;
    if (isFollowUp) {
      systemPrompt = GLOBAL_REFINEMENT_RULES + '\n\n' + FOLLOW_UP_REFINEMENT_PROMPT;
      console.log('[routing] Using Turn 2+ Follow-Up Refinement Prompt');
    } else {
      systemPrompt = GLOBAL_REFINEMENT_RULES + '\n\n' + SKILL_REFINEMENT_PROMPT
        .replace('{{skill}}', skill)
        .replace('{{detected_language}}', detectedLanguage || 'indonesian');
      console.log('[routing] Using Turn 1 Skill Refinement Prompt (lang=' + (detectedLanguage || 'indonesian') + ')');
    }

    const parts: string[] = [`Original request: ${originalPrompt}`];
    if (documentContext) {
      parts.push(`Document context: ${documentContext}`);
    }
    if (conversationContext) {
      parts.push(`Recent conversation history: ${conversationContext}`);
    }
    const userContent = parts.join('\n\n');

    const command = new ConverseCommand({
      modelId: config.routing.scoringModelId,
      system: [{ text: systemPrompt }],
      messages: [
        {
          role: 'user',
          content: [{ text: userContent }],
        },
      ],
      inferenceConfig: {
        maxTokens: 1024,
        temperature: 0.3,
      },
    });

    const response = await bedrockClient.send(command, {
      abortSignal: controller.signal,
    });

    const outputText = response.output?.message?.content?.[0]?.text;
    if (!outputText || outputText.trim().length === 0) {
      return { flowingText: null, contract: null };
    }

    // Parse JSON and return both flowing text + structured contract
    const _refRaw = parseRefinementContract(outputText);
    // Also capture the raw prompt for debugging
    const _refRawPrompt = systemPrompt.slice(0, 500) + '\n\n[User]: ' + userContent.slice(0, 500);
    return { flowingText: _refRaw.flowingText, contract: _refRaw.contract, _rawResponse: outputText, _rawPrompt: _refRawPrompt };
  } catch {
    // Any failure (timeout, API error, parse error) → return null
    return { flowingText: null, contract: null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Merged classification + complexity scoring in a single LLM call.
 * Replaces two separate calls (classifyRequestType + scoreComplexity) to cut
 * routing latency by ~50%. Returns skill, score, and confidence.
 *
 * @returns { skill, complexityScore, confidence } or null on failure
 */
async function unifiedClassifyAndScore(
  prompt: string,
  documentText?: string,
  conversationContext?: string,
  hasEmptyPrompt?: boolean,
  hasImages?: boolean,
): Promise<{ skill: SkillType; complexityScore: number; confidence: number; language: string; languageConfidence: number; sessionContext?: string; _rawResponse?: string; _rawPrompt?: string } | null> {
  // Silent upload: files but no prompt → fallback (ask user what they want)
  if (hasEmptyPrompt && (hasImages || documentText)) {
    return { skill: 'fallback', complexityScore: 2, confidence: 0.9, language: 'indonesian', languageConfidence: 0.9, sessionContext: 'Silent upload — bertanya ke user', _rawResponse: '(silent upload - no LLM call)', _rawPrompt: '(silent upload - no LLM call)' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.routing.scoringTimeoutMs);

  try {
    const promptPart = prompt.length > 1000 ? prompt.slice(0, 1000) + '...' : prompt;

    let documentPart = '';
    if (documentText) {
      // Extract head + tail for best coverage: title/caveats are usually at start,
      // conclusions/next-steps at end. Middle is often filler that adds less signal.
      const HEAD = 1500, MID = 800, TAIL = 700;
      let snippet: string;
      if (documentText.length > HEAD + TAIL) {
        const midStart = Math.floor((documentText.length - MID) / 2);
        snippet = documentText.slice(0, HEAD) + '\n\n[...]\n\n' + documentText.slice(midStart, midStart + MID) + '\n\n[...]\n\n' + documentText.slice(-TAIL);
      } else {
        snippet = documentText;
      }
      documentPart = `\n\nUploaded document content:\n${snippet}`;
    }

    let contextPart = '';
    if (conversationContext) {
      contextPart = `\n\nConversation history:\n${conversationContext}`;
    }

    const systemPrompt = [
      'You are an expert intent classifier and complexity scorer for an AI routing engine. Classify the user request into ONE skill and score its complexity 1-5.',
      '',
      '### SKILLS (Choose exactly one)',
      '[Generation] business_writing | creative_writing | brainstorming | prompt_optimizer',
      '[Transformation] summarization | translation | data_transformation | editing',
      '[Interaction] roleplay | logic_math | planning_strategy | document_analysis',
      '[Enterprise] requirement_generation | compliance_pre_assessment | risk_analyst | process_optimization | credit_analyst | meeting_summary',
      '[Engineering] code | log_troubleshooting | data_analysis | cloud_security | it_specialist | fallback',
      '',
      'Skill definitions:',
      '- business_writing: compose or reply to business emails, memos, professional correspondence',
      '- creative_writing: creative writing, stories, poems',
      '- brainstorming: ideation, idea generation',
      '- prompt_optimizer: prompt engineering assistance',
      '- summarization: condense text, extract key points',
      '- translation: convert between languages',
      '- data_transformation: transform data formats (JSON, CSV, etc.)',
      '- editing: proofread, review, improve text',
      '- roleplay: act as a character in a scenario',
      '- logic_math: solve logic puzzles, math problems, proofs',
      '- planning_strategy: create plans, roadmaps, strategies',
      '- requirement_generation: create formal requirements, BRD, PRD',
      '- compliance_pre_assessment: evaluate regulatory compliance',
      '- risk_analyst: risk assessment and mitigation analysis',
      '- process_optimization: business process improvement',
      '- meeting_summary: extract summary, decisions, action items from meeting transcripts',
      '- code: write, review, debug code',
      '- log_troubleshooting: debug system logs, errors, incidents',
      '- data_analysis: statistical analysis, data insights',
      '- fallback: catch-all for everything else',
      '',
      '### CRITICAL CLASSIFICATION RULES',
      '- Cloud security/infrastructure context → "cloud_security"',
      '- Meeting transcript with "minutes", "meeting", "rapat", "notulen", or "transcript" context → "meeting_summary"',
      '- Credit/financial/SLIK assessment → "credit_analyst"',
      '- IT system/technical documentation → "it_specialist"',
      '- Document contains code to analyze/fix → "code"',
      '- Financial/regulatory/legal content → "compliance_pre_assessment"',
      '- Request to write code → "code"',
      '',
      '### ⚠️ STRICT NEGATIVE CONSTRAINTS — COMPLIANCE SKILL',
      '- NEVER use compliance_pre_assessment for purely technical, architectural, software engineering, or IT documents (e.g., Tech Reference, Node.js architecture, AWS Bedrock configs, code reviews).',
      '- compliance_pre_assessment is STRICTLY reserved for legal, financial, tax, or government regulatory documents (e.g., OJK, Bank Indonesia, ISO audits, UU PDP).',
      '- If the user asks to evaluate a technical implementation or architecture, use editing or code instead.',
      '',
      '### COMPLEXITY SCORING (1-5)',
      '- CRITICAL: If the user asks to "evaluate", "review", or "analyze" an ENTIRE technical document, architecture, or system (not just a small section or single concept), the complexity_score MUST be 4 or 5. This triggers advanced reasoning (Thinking Mode).',
      '  - Example: "evaluasi dokumen ini" regarding a full Tech Reference document = Score 4.',
      '- MULTI-QUESTION RULE: If the user asks 3 or more distinct questions in a single prompt, the complexity_score MUST be 4 or higher. Example: "Apa itu REST API? Bagaimana cara kerjanya? Apa bedanya dengan SOAP?" = Score 4.',
      'Score 1: Trivial — greetings, yes/no, simple factual lookup, basic translation of a word. Example: "what is 2+2", "hi", "terjemahkan buku"',
      'Score 2: Standard — basic summarization, simple email drafting, general Q&A, straightforward code snippet. Example: "summarize this email", "tulis email resignasi", "apa itu REST API"',
      'Score 3: Moderate — multi-step reasoning, standard document analysis, comparison, debugging typical logs, data transformation. Example: "compare these two options", "analisa dokumen ini", "convert JSON ke CSV"',
      'Score 4: Complex — deep compliance/regulatory review, complex logic/math, large document synthesis, multi-domain reasoning. Example: "evaluasi kepatuhan dokumen ini terhadap BI regulation", "lakukan analisis risiko keamanan sistem pembayaran". [TRIGGERS THINKING MODE]',
      'Score 5: Expert — highly abstract strategy, extreme edge-case troubleshooting, massive multi-document synthesis, zero-day vulnerability analysis. Example: "lakukan gap analysis menyeluruh terhadap seluruh framework keamanan yang ada". [TRIGGERS THINKING MODE]',
      '',
      '### LANGUAGE DETECTION',
      'Detect the user\'s language. If the user explicitly requests a different language (e.g. "gunakan bahasa inggris", "speak English"), detect the REQUESTED language, not the prompt language.',
      '',
      '### OUTPUT FORMAT (JSON only, no markdown)',
      '{',
      '  "skill": "<one of the 20 skills>",',
      '  "complexity_score": <1-5>,',
      '  "confidence": <0.0-1.0>,',
      '  "detected_language": "<language name in English, e.g. indonesian, english>",',
      '  "language_confidence": <0.0-1.0>,',
      '  "reasoning": "<brief 1-sentence justification>"',
      '}',
    ].join('\n');

    const userContent = `${promptPart}${documentPart}${contextPart}`;

    const command = new ConverseCommand({
      modelId: config.routing.scoringModelId,
      system: [{ text: systemPrompt }],
      messages: [{ role: 'user', content: [{ text: userContent }] }],
      inferenceConfig: { maxTokens: 150, temperature: 0 },
    });

    const response = await bedrockClient.send(command, { abortSignal: controller.signal });
    const outputText = response.output?.message?.content?.[0]?.text?.trim();
    if (!outputText) return null;

    // Strip markdown fences
    const cleaned = outputText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    const skill = extractSkill(String(parsed.skill ?? ''));
    const complexityScore = typeof parsed.complexity_score === 'number'
      ? Math.max(1, Math.min(5, Math.round(parsed.complexity_score)))
      : config.routing.defaultFallbackScore;
    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;

    const language = typeof parsed.detected_language === 'string'
      ? parsed.detected_language.trim().toLowerCase()
      : 'indonesian';
    const languageConfidence = typeof parsed.language_confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.language_confidence))
      : 0.5;

    const sessionContext = typeof parsed.reasoning === 'string'
      ? parsed.reasoning.slice(0, 120)
      : undefined;

    return { skill, complexityScore, confidence, language, languageConfidence, sessionContext, _rawResponse: outputText, _rawPrompt: systemPrompt.slice(0, 800) + '\n\n[User]: ' + userContent.slice(0, 500) };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Maps a complexity score to its band name.
 * Complexity 1 → Qwen3 32B (simple, fast answers)
 * Complexity 2-3 → moderate (needs stronger model)
 * Complexity 4-5 → advanced (needs highest-capability model)
 */
function scoreToBand(score: number): 'direct-answer' | 'moderate-reasoning' | 'advanced-reasoning' {
  if (score <= 1) return 'direct-answer';
  if (score <= 3) return 'moderate-reasoning';
  return 'advanced-reasoning';
}

/**
 * Deterministic verifier — checks assistant output against the prompt contract.
 * No LLM call. Returns structured verification result with pass/fail per check.
 */
export function verifyOutput(
  contract: PromptContract,
  assistantText: string,
): VerificationResult {
  const checks: VerificationResult['checks'] = [];
  const violations: VerificationResult['violations'] = [];

  // 1. Empty output check
  if (!assistantText || assistantText.trim().length === 0) {
    violations.push({ field: 'output', issue: 'Empty assistant response', severity: 'error' });
    checks.push({ name: 'Empty output', passed: false, detail: 'No text returned' });
    return { passed: false, violations, checks };
  }
  checks.push({ name: 'Empty output', passed: true, detail: `${assistantText.length} chars` });

  // 2. PII placeholder check — intentionally SKIPPED.
  // PII placeholders ([NIK_1], [NAMA_2]) in output are CORRECT — they mean
  // the PII masker worked. Flagging them as "leaks" causes false-positive
  // repairs (e.g. translated output preserving masked references).
  // PII masking is fail-closed at input — if real PII reaches the model,
  // that's a masker bug, not a post-hoc verifier concern.
  checks.push({ name: 'PII leakage', passed: true, detail: 'Check disabled — placeholders in output are expected' });

  // 3. Word count check from contract constraints
  if (contract.constraints) {
    for (const constraint of contract.constraints) {
      const wordMatch = constraint.match(/under\s+(\d+)\s+words?/i);
      if (wordMatch) {
        const maxWords = parseInt(wordMatch[1], 10);
        const wordCount = assistantText.trim().split(/\s+/).length;
        if (wordCount > maxWords) {
          violations.push({
            field: 'constraints.wordCount',
            issue: `Word count exceeded: ${wordCount}/${maxWords}`,
            severity: 'warn',
          });
          checks.push({ name: 'Word count', passed: false, detail: `${wordCount}/${maxWords}` });
        } else {
          checks.push({ name: 'Word count', passed: true, detail: `${wordCount}/${maxWords}` });
        }
      }
    }
  }

  // 4. Required sections check from format.mustInclude
  if (contract.format?.mustInclude) {
    for (const section of contract.format.mustInclude) {
      const found = assistantText.toLowerCase().includes(section.toLowerCase());
      if (!found) {
        violations.push({
          field: `format.mustInclude.${section}`,
          issue: `Missing required section: "${section}"`,
          severity: 'error',
        });
      }
      checks.push({ name: `Required: ${section}`, passed: found, detail: found ? 'Present' : 'Missing' });
    }
  }

  // 5. Forbidden content check from format.mustAvoid
  if (contract.format?.mustAvoid) {
    for (const avoid of contract.format.mustAvoid) {
      const found = assistantText.toLowerCase().includes(avoid.toLowerCase());
      if (found) {
        violations.push({
          field: `format.mustAvoid.${avoid}`,
          issue: `Contains prohibited content: "${avoid}"`,
          severity: 'error',
        });
      }
      checks.push({ name: `Avoid: ${avoid}`, passed: !found, detail: found ? 'Found' : 'Absent' });
    }
  }

  // 6. Format quality check — unclosed markdown delimiters
  const unclosedBold = (assistantText.match(/\*\*/g) || []).length % 2 !== 0;
  if (unclosedBold) {
    checks.push({ name: 'Format: unclosed bold', passed: false, detail: 'Unclosed ** detected' });
    violations.push({ field: 'format.markdown', issue: 'Unclosed bold (**) markers', severity: 'warn' });
  } else {
    checks.push({ name: 'Format: unclosed bold', passed: true, detail: 'OK' });
  }

  const unclosedCode = (assistantText.match(/`/g) || []).length % 2 !== 0;
  if (unclosedCode) {
    checks.push({ name: 'Format: unclosed code', passed: false, detail: 'Unclosed ` detected' });
    violations.push({ field: 'format.markdown', issue: 'Unclosed inline code (`) markers', severity: 'warn' });
  } else {
    checks.push({ name: 'Format: unclosed code', passed: true, detail: 'OK' });
  }

  // 7. Heading consistency check — detect mixed [bracketed] and ALL-CAPS headings
  const bracketedHeadings = assistantText.match(/^\[.+\]$/gm) || [];
  const allCapsHeadings = assistantText.match(/^[A-Z][A-Z\s]{3,}$/gm) || [];
  if (bracketedHeadings.length > 0 && allCapsHeadings.length > 0) {
    checks.push({ name: 'Format: heading consistency', passed: false, detail: `Mixed [bracketed] (${bracketedHeadings.length}) and ALL-CAPS (${allCapsHeadings.length}) headings` });
    violations.push({ field: 'format.headings', issue: 'Inconsistent heading format: mixed [bracketed] and ALL-CAPS', severity: 'warn' });
  } else {
    checks.push({ name: 'Format: heading consistency', passed: true, detail: `${bracketedHeadings.length || allCapsHeadings.length} headings, consistent style` });
  }

  const passed = violations.filter(v => v.severity === 'error').length === 0;
  return { passed, violations, checks };
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
 * Post-classification invariant validator.
 * Runs AFTER unifiedClassifyAndScore() — demotes impossible skills to 'fallback'
 * based on hard business rules. Zero LLM cost, purely deterministic.
 */
function validateSkillInvariants(skill: SkillType, input: RoutingInput): SkillType {
  const fullContext = `${input.originalPrompt} ${input.maskedDocumentText || ''}`.toLowerCase();

  // Rule 1: Compliance requires legal/financial/regulatory context
  if (skill === 'compliance_pre_assessment') {
    const hasLegalContext = /legal|financial|regulatory|compliance|kepatuhan|peraturan/.test(fullContext);
    if (!hasLegalContext) return 'fallback';
  }

  // Rule 2: Risk Analyst requires risk/threat context
  if (skill === 'risk_analyst') {
    const hasRiskContext = /risk|threat|vulnerability|risiko/.test(fullContext);
    if (!hasRiskContext) return 'fallback';
  }

  // Rule 3: Data Analysis requires data/statistical context
  if (skill === 'data_analysis') {
    const hasDataContext = /data|statistical|trend|analisis/.test(fullContext);
    if (!hasDataContext) return 'fallback';
  }

  // Rule 4: Code requires actual code indicators
  if (skill === 'code') {
    const hasCodeBlocks = input.originalPrompt.includes('```');
    const hasCodeKeywords = /\b(function|class|var|let|const|def|import|public|private)\b/.test(input.originalPrompt.toLowerCase());
    if (!hasCodeBlocks && !hasCodeKeywords) return 'fallback';
  }

  // Rule 5: Process optimization requires process/workflow context
  if (skill === 'process_optimization') {
    const hasProcessContext = /process|workflow|optimize|bottleneck|efisiensi|alur/.test(fullContext);
    if (!hasProcessContext) return 'fallback';
  }

  // Rule 6: Document analysis requires an attached document
  if (skill === 'document_analysis') {
    if (!input.maskedDocumentText) return 'fallback';
  }

  // Rule 7: Cloud security requires cloud/infrastructure context
  if (skill === 'cloud_security') {
    const hasCloudContext = /cloud|gcp|aws|waf|firewall|infrastructure|keamanan.*cloud/.test(fullContext);
    if (!hasCloudContext) return 'fallback';
  }

  // Rule 8: Credit analyst requires credit/financial context
  if (skill === 'credit_analyst') {
    const hasCreditContext = /credit|loan|slik|financial|kredit|pinjaman|keuangan/.test(fullContext);
    if (!hasCreditContext) return 'fallback';
  }

  // Rule 9: Meeting summary requires transcript/meeting context
  if (skill === 'meeting_summary') {
    const hasMeetingContext = /meeting|rapat|notulen|transcript|minutes|agenda|action.item|keputusan/.test(fullContext);
    if (!hasMeetingContext) return 'fallback';
  }

  // Rule 10: IT specialist requires IT/system context
  if (skill === 'it_specialist') {
    const hasITContext = /it system|technical|infrastructure|architecture|payment|sistem|infrastruktur/.test(fullContext);
    if (!hasITContext) return 'fallback';
  }

  return skill;
}

/**
 * Main entry point for the routing engine.
 * Performs prompt refinement, complexity scoring, and policy-based routing.
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
      contract: null,
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
      contract: null,
      sessionContext: input.originalPrompt.slice(0, 120), // first 120 chars as preview
    };
  }

  // Auto state: unified classify+score → refine → route
  let refinedPrompt: string = input.originalPrompt;
  let complexityScore: number = config.routing.defaultFallbackScore;
  let confidence: number = 0.5;
  let skill: SkillType = 'fallback';
  const routingStart = Date.now();
  let classificationDurationMs: number | undefined;
  let scoringDurationMs: number | undefined;

  // Step 0: Unified classification + complexity scoring (single LLM call)
  const unifiedStart = Date.now();
  const unifiedResult = await unifiedClassifyAndScore(
    input.originalPrompt,
    input.maskedDocumentText,
    input.conversationContext,
    !input.originalPrompt.trim(),
    input.hasImages,
  );
  const unifiedDuration = Date.now() - unifiedStart;
  if (unifiedResult !== null) {
    skill = unifiedResult.skill;
    complexityScore = unifiedResult.complexityScore;
    confidence = unifiedResult.confidence;
    // Post-classification invariant check — demote impossible skills
    const validatedSkill = validateSkillInvariants(skill, input);
    if (validatedSkill !== skill) {
      flags.push(`skill-demoted:${skill}→${validatedSkill}`);
      console.log(`[routing] Invariant check: ${skill} demoted to ${validatedSkill}`);
      skill = validatedSkill;
    }
    console.log(`[routing] Unified classify+score: skill=${skill}, score=${complexityScore}, confidence=${confidence}, lang=${unifiedResult.language} in ${unifiedDuration}ms`);
  } else {
    // Unified call failed — fallback to defaults
    flags.push('routing-fallback');
    console.warn(`[routing] Unified classify+score failed after ${unifiedDuration}ms, using defaults`);
  }

  // Step 1: Prompt refinement (skill-aware)
  const refinementStart = Date.now();
  const refinementResult = await refinePrompt(input.originalPrompt, input.maskedDocumentText, skill, input.conversationContext, unifiedResult?.language);
  const refinementDurationMs = Date.now() - refinementStart;
  let contract: PromptContract | null = null;
  if (refinementResult.flowingText !== null) {
    refinedPrompt = refinementResult.flowingText;
    contract = refinementResult.contract;

    // Task verbatim validator — force task to match original prompt exactly
    if (contract?.task && contract.task !== input.originalPrompt) {
      console.warn(`[routing] Task not verbatim — correcting. Expected: "${input.originalPrompt.substring(0, 50)}...", Got: "${contract.task.substring(0, 50)}..."`);
      contract.task = input.originalPrompt;
    }

    // Inject static role from skill-role-map, overriding any LLM-generated role
    const staticRole = getRoleForSkill(skill);

    // Discovery hook: log novel roles from fallback refinement for admin review
    if (skill === 'fallback' && refinementResult._rawResponse) {
      try {
        const raw = JSON.parse(refinementResult._rawResponse);
        const llmRole = typeof raw.role === 'string' ? raw.role.trim() : '';
        if (llmRole && llmRole !== staticRole) {
          await query(`
            INSERT INTO discovered_roles (role, count, last_seen, sample_context, sample_intent)
            VALUES ($1, 1, NOW(), $2, $3)
            ON CONFLICT (role) DO UPDATE SET
              count = discovered_roles.count + 1,
              last_seen = NOW(),
              sample_context = CASE WHEN discovered_roles.sample_context IS NULL THEN $2 ELSE discovered_roles.sample_context END,
              sample_intent = CASE WHEN discovered_roles.sample_intent IS NULL THEN $3 ELSE discovered_roles.sample_intent END
          `, [llmRole, raw.context || '', raw.intent || '']).catch(() => {});
        }
      } catch { /* parse failure - skip */ }
    }

    if (contract) contract.role = staticRole;

    // Rebuild flowingText with static role + dynamic instructions
    const rebuiltParts: string[] = [];
    if (contract?.task) rebuiltParts.push(contract.task);
    if (contract?.context) rebuiltParts.push('\n\n---\n' + contract.context);
    if (contract?.role) rebuiltParts.push('\n\nRole: ' + contract.role);
    if (contract?.behavioral_instructions) rebuiltParts.push('\n\nGuidelines:\n' + contract.behavioral_instructions);
    if (contract?.output_format) rebuiltParts.push('\n\nFormat:\n' + contract.output_format);
    if (rebuiltParts.length > 0) refinedPrompt = rebuiltParts.join('');

    console.log(`[routing] Prompt refinement (${skill}) succeeded in ${refinementDurationMs}ms`);
  } else {
    // Refinement failed: use original prompt and flag
    flags.push('refinement-failed');
    console.warn(`[routing] Prompt refinement failed after ${refinementDurationMs}ms, using original prompt`);
  }

  // Step 3: Determine long context
  const totalInputLength = (input.originalPrompt?.length ?? 0) + (input.maskedDocumentText?.length ?? 0);
  const isLongContext = totalInputLength > config.routing.longContextThreshold;

  // Step 4: Build policy input and resolve
  const policyInput: PolicyInput = {
    complexityScore,
    hasImages: input.hasImages,
    isLongContext,
    routingState: 'auto',
  };

  let policyResult;
  try {
    policyResult = resolvePolicy(policyInput);
  } catch {
    // Policy failure: fallback to default model
    policyResult = { modelId: 'qwen.qwen3-32b-v1:0', reasonCode: 'routing-fallback' };
    flags.push('policy-failed');
  }

  // Step 5: Map score to band
  const scoreBand = scoreToBand(complexityScore);

  // Step 6: Generate reasoning summary
  const reasoningParts = [`skill=${skill} → complexity band ${scoreBand}`];
  if (isLongContext) {
    reasoningParts.push('long-context override');
  }
  reasoningParts.push(getModalityDescription(modalityFlags));
  if (flags.length > 0) {
    reasoningParts.push(`flags: [${flags.join(', ')}]`);
  }
  const reasoningSummary = reasoningParts.join(', ');

  // Step 7: Return complete routing decision with per-step timing
  return {
    executedModelId: policyResult.modelId,
    routingState: 'auto',
    complexityScore,
    scoreBand,
    confidence,
    refinedPrompt,
    routingReasonCode: policyResult.reasonCode,
    reasoningSummary,
    modalityFlags,
    manualOverrideApplied: false,
    flags,
    skill,
    contract,
    detectedLanguage: unifiedResult?.language ?? 'indonesian',
    sessionContext: unifiedResult?.sessionContext,
    routingDurationMs: Date.now() - routingStart,
    classificationDurationMs,
    refinementDurationMs,
    scoringDurationMs,
    _classRaw: (unifiedResult as any)?._rawResponse,
    _classPrompt: (unifiedResult as any)?._rawPrompt,
    _refineRaw: (refinementResult as any)?._rawResponse,
    _refinePrompt: (refinementResult as any)?._rawPrompt,
  } as any;
}

/**
 * Returns a deterministic format template for the given skill.
 * Replaces dynamic output_format generation by the refinement LLM.
 * Templates are grouped by skill category.
 */
const STRUCTURED_SKILLS: Set<SkillType> = new Set([
  'compliance_pre_assessment', 'requirement_generation', 'risk_analyst',
  'process_optimization', 'credit_analyst', 'meeting_summary', 'code', 'log_troubleshooting',
  'data_analysis', 'cloud_security', 'it_specialist', 'editing',
  'document_analysis', 'planning_strategy', 'logic_math',
]);

export function getDefaultFormatTemplate(skill: SkillType): string | null {
  if (skill === 'meeting_summary') {
    return [
      'Gunakan heading deskriptif untuk setiap section. PII placeholders ([NIK_1], [NO_HP_1], etc.) HARUS dipertahankan — jangan diexpand atau diganti.',
      '',
      'STRUKTUR OUTPUT (JSON):',
      '{',
      '  "summary": "Executive summary dalam 3-5 paragraf — mencakup topik utama, diskusi kunci, hasil, dan konteks."',
      '  "decisions": ["Keputusan 1", "Keputusan 2", ...]',
      '  "actionItems": [',
      '    { "task": "Deskripsi tugas", "owner": "Nama pemilik (jika disebutkan)" }',
      '  ]',
      '}',
      '',
      'ATURAN:',
      '- Summary dalam bahasa yang sama dengan transkrip (Indonesia atau Inggris).',
      '- Decisions: kalimat singkat dan actionable.',
      '- Action items: spesifik, dengan owner jika disebut dalam transkrip.',
      '- JANGAN mengubah atau mengexpand PII placeholders.',
    ].join('\n');
  }
  if (skill === 'requirement_generation') {
    return [
      'Gunakan heading yang deskriptif dan alami untuk setiap section (tanpa tanda kurung siku).',
      '',
      'STRUKTUR WAJIB (7 section):',
      '1. Ringkasan Eksekutif — berisi Konteks Bisnis, Baseline KPI, dan Target KPI dengan angka terukur.',
      '2. Non-Functional Requirements — dalam format tabel: Latency SLA, Throughput, Availability, Resiliensi. Setiap NFR harus memiliki angka spesifik.',
      '3. Strategi Implementasi per Fase — minimal 2 fase dengan fokus dan batasan yang jelas per fase.',
      '4. Prinsip Desain & Arsitektur — daftar bernomor, setiap prinsip satu kalimat tegas.',
      '5. User Story & Acceptance Criteria per Domain — dikelompokkan berdasarkan fase dan domain:',
      '   Format setiap User Story:',
      '   **US X.Y: Judul**',
      '   - Actor: [peran spesifik]',
      '   - Story: Sebagai [actor], saya ingin [tujuan], agar [manfaat].',
      '   - UAC:',
      '     1. Given [kondisi awal], When [aksi], Then [hasil yang diharapkan — dengan angka/metrik].',
      '6. Strategi Data, AI/ML & Governance — daftar prinsip bernomor.',
      '7. Instruksi Handover — poin-poin untuk tim System Design/Engineering.',
      '',
      'ATURAN KUALITAS UAC:',
      '- SETIAP UAC wajib mengandung Given/When/Then (Diberikan/Ketika/Maka).',
      '- SETIAP UAC wajib memiliki minimal satu kriteria terukur (angka, persentase, SLA waktu).',
      '- SETIAP User Story wajib memiliki Actor yang spesifik (bukan "User" generik).',
    ].join('\n');
  }
  if (STRUCTURED_SKILLS.has(skill)) {
    return 'Gunakan heading yang deskriptif dan alami untuk setiap section (tanpa tanda kurung siku).\nUntuk setiap poin dalam section, gunakan format: N. Judul\n   - Detail sub-poin\n\nPisahkan setiap section dengan baris kosong.';
  }
  return null;
}

/** Exposed for testing — allows injecting a mock Bedrock client. */
export function _setBedrockClient(client: BedrockRuntimeClient): void {
  Object.assign(bedrockClient, client);
}

/** Exposed for testing. */
export { bedrockClient as _bedrockClient };

/** Exposed for testing — post-classification invariant validator. */
export { validateSkillInvariants as _validateSkillInvariants };
