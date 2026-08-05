/**
 * Sequential Reasoning Engine — multi-step reasoning for complex queries.
 *
 * For complex requests (complexity >= 4), generates a step-by-step execution
 * plan, executes steps sequentially with accumulated context, performs
 * progressive synthesis, and always runs a final synthesizer layer.
 *
 * @see docs/feature-sequential-reasoning/
 */

import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient } from './inference.service.js';
import { mask } from './pii-masker.service.js';
import { auditService } from './audit.service.js';
import { config } from '../config/index.js';
import type {
  SequentialPlan,
  SequentialStep,
  StepResult,
  SequentialOrchestrationMeta,
  OrchestrationStatusEvent,
} from '../types/inference.types.js';
import type { RoutingDecision } from '../types/routing.types.js';
import type { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

/** Default max tokens for step-level Bedrock calls. */
const STEP_MAX_TOKENS = 8192;
/** Quick synthesis uses same default but smaller model. */
const INTERIM_MAX_TOKENS = 2048;
/** Timeout per step Bedrock call. */
const STEP_TIMEOUT_MS = 60_000;

export interface SequentialReasoningInput {
  originalPrompt: string;           // PII-masked
  refinedPrompt: string;            // Post-routing refined
  maskedDocumentText?: string;      // For map-reduce trigger
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: any }>;
  userId: string;
  sessionId: string;
  username: string;
  routingDecision: RoutingDecision;
}

export interface SequentialReasoningResult {
  assistantText: string;
  plan: SequentialPlan;
  stepResults: StepResult[];
  synthesisStatus: 'success' | 'partial' | 'failed';
  orchestrationMeta: SequentialOrchestrationMeta;
}

class SequentialReasoner {
  private readonly cfg = config.orchestration;

  /**
   * Main entry point.
   * Returns null if planner decides sequential reasoning isn't needed
   * (caller falls back to standard single-shot generate).
   */
  async execute(input: SequentialReasoningInput, res: Response): Promise<SequentialReasoningResult | null> {
    const startTime = Date.now();
    const orchestrationGroupId = uuidv4();

    // ── Planner ──────────────────────────────────────────────────
    const plan = await this.planner(input);
    if (!plan || plan.steps.length < 2) {
      console.log('[seq-reasoning] Planner returned <2 steps — falling back to single-shot');
      return null;
    }

    // Emit plan SSE
    this.emitPlanEvent(res, plan);
    console.log(`[seq-reasoning] Plan: ${plan.steps.length} steps — ${plan.steps.map(s => s.name).join(' → ')}`);

    // Audit planner call
    auditService.log({
      timestamp: new Date().toISOString(),
      userId: input.userId,
      username: input.username,
      modelId: this.resolveModel(input.routingDecision),
      inputTokens: 0,  // Will be updated after actual call
      outputTokens: 0,
      status: 'success',
      durationMs: 0,
      routingState: 'auto',
      orchestrationGroupId,
      orchestrationStepOrder: 0,
    }).catch(() => {});

    // ── Executor ─────────────────────────────────────────────────
    // Initialize accumulated context with document text and conversation history
    // so steps can reference original content instead of hallucinating.
    const contextParts: string[] = [];
    if (input.maskedDocumentText) {
      // Cap document text at threshold — full text goes to Data Cruncher step
      // but subsequent steps get the condensed summary, not the raw mega-doc.
      const docText = input.maskedDocumentText.length > this.cfg.largeDocumentThreshold
        ? input.maskedDocumentText.slice(0, this.cfg.largeDocumentThreshold) + '\n...[truncated]'
        : input.maskedDocumentText;
      contextParts.push(`[Uploaded Document]\n${docText}`);
    }
    if (input.conversationHistory.length > 0) {
      const historyText = input.conversationHistory
        .map(m => `[${m.role.toUpperCase()}]\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
        .join('\n\n');
      contextParts.push(`[Conversation History]\n${historyText}`);
    }
    let accumulatedContext = contextParts.length > 0 ? contextParts.join('\n\n') + '\n\n' : '';
    const stepResults: StepResult[] = [];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const stepStart = Date.now();
      let stepStatus: StepResult['status'] = 'success';
      let stepOutput = '';
      let retryCount = 0;
      let errorMsg: string | undefined;

      // Emit status: running
      this.emitStatusEvent(res, step, plan.steps.length, 'running');

      for (let attempt = 0; attempt < this.cfg.stepRetryCount; attempt++) {
        retryCount = attempt;
        const useSimplified = attempt >= 1;
        const prompt = this.buildStepPrompt(step, accumulatedContext, useSimplified);

        try {
          // PII mask step input
          const maskedPrompt = mask(prompt).maskedText;

          // Run step with language awareness
          const lang = input.routingDecision?.detectedLanguage;
          stepOutput = await this.callStepModel(step, maskedPrompt, lang);
          if (!stepOutput || stepOutput.trim().length === 0) {
            throw new Error('Step produced empty output');
          }

          // PII mask step output (fail-closed)
          const maskedOutput = mask(stepOutput).maskedText;
          stepOutput = maskedOutput;

          // Append to accumulated context
          accumulatedContext += `\n\n[Step ${step.order}: ${step.name}]\n${stepOutput}`;
          stepStatus = 'success';
          break; // success
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[seq-reasoning] Step ${step.order} attempt ${attempt + 1} failed: ${msg}`);
          if (attempt < this.cfg.stepRetryCount - 1) {
            continue; // retry
          }
          stepStatus = 'failed';
          errorMsg = msg;
        }
      }

      const durationMs = Date.now() - stepStart;

      if (stepStatus === 'failed') {
        // Emit error event
        res.write(`event: orchestration_error\ndata: ${JSON.stringify({
          step: step.order,
          name: step.name,
          reason: errorMsg || 'Step failed after retries',
        })}\n\n`);

        // Emit status: failed
        this.emitStatusEvent(res, step, plan.steps.length, 'failed', durationMs);
      } else {
        // Emit step output via SSE
        res.write(`event: orchestration_step\ndata: ${JSON.stringify({ step: step.order, content: stepOutput })}\n\n`);

        // Emit status: completed
        this.emitStatusEvent(res, step, plan.steps.length, 'completed', durationMs);
      }

      const stepTokens = this.estimateTokens(stepOutput);
      stepResults.push({
        order: step.order,
        status: stepStatus,
        inputTokens: stepTokens,
        outputTokens: stepTokens,
        durationMs,
        retryCount,
        errorMessage: errorMsg,
      });

      // Audit per step
      auditService.log({
        timestamp: new Date().toISOString(),
        userId: input.userId,
        username: input.username,
        modelId: step.modelId,
        inputTokens: stepTokens,
        outputTokens: stepTokens,
        status: stepStatus === 'success' ? 'success' : 'failed',
        durationMs,
        routingState: 'auto',
        sessionId: input.sessionId,
        orchestrationGroupId,
        orchestrationStepOrder: step.order,
      }).catch(() => {});

      // ── Progressive synthesis ───────────────────────────────
      if (this.cfg.progressiveInterval > 0 && (step.order % this.cfg.progressiveInterval === 0)) {
        await this.emitInterimSynthesis(res, accumulatedContext, step, plan.steps.length);
      }
    }

    // ── Synthesizer (always runs) ─────────────────────────────────
    const synthesisStatus = stepResults.some(r => r.status === 'success')
      ? ('partial' as const)
      : ('failed' as const);
    const allSuccess = stepResults.every(r => r.status === 'success');
    const finalStatus = allSuccess ? 'success' as const : synthesisStatus;

    let assistantText: string;
    try {
      assistantText = await this.synthesizer(input, plan, accumulatedContext, stepResults, res);
    } catch (err: unknown) {
      const synthesisErr = err instanceof Error ? err.message : String(err);
      console.error(`[seq-reasoning] Synthesizer failed: ${synthesisErr}`);
      // Fallback: emit accumulated context as raw response
      assistantText = accumulatedContext || input.refinedPrompt;
    }

    // Clean markdown artifacts from final output (skip for code skills)
    const cleanedText = stripMarkdownArtifacts(assistantText, input.routingDecision.skill);
    if (cleanedText !== assistantText) {
      console.log(`[seq-reasoning] Markdown cleanup applied: ${assistantText.length} → ${cleanedText.length} chars`);
    }

    // Use cleaned text for both streaming and storage
    assistantText = cleanedText;

    // Stream final text as standard delta events
    res.write(`event: delta\ndata: ${JSON.stringify({ type: 'text', content: assistantText })}\n\n`);

    const totalDurationMs = Date.now() - startTime;
    const totalInputTokens = stepResults.reduce((s, r) => s + r.inputTokens, 0);
    const totalOutputTokens = stepResults.reduce((s, r) => s + r.outputTokens, 0);

    const orchestrationMeta: SequentialOrchestrationMeta = {
      plan: { steps: plan.steps.map(s => ({ name: s.name, description: s.description })) },
      stepResults,
      synthesisStatus: finalStatus,
      totalInputTokens,
      totalOutputTokens,
      totalDurationMs,
    };

    return {
      assistantText,
      plan,
      stepResults,
      synthesisStatus: finalStatus,
      orchestrationMeta,
    };
  }

  // ── Planner ───────────────────────────────────────────────────

  private async planner(input: SequentialReasoningInput): Promise<SequentialPlan | null> {
    const modelId = this.resolveModel(input.routingDecision);

    // Detect map-reduce need
    const isLargeDoc = (input.maskedDocumentText?.length ?? 0) > this.cfg.largeDocumentThreshold;

    // Build system prompt describing the task
    const systemPrompt = `You are a reasoning planner. Analyze the user request and generate a step-by-step execution plan.

Rules:
- Output a JSON object with "steps" array and "reasoning" string
- Each step has: order (1-indexed), name (short), description (one line), systemPrompt (instructions for that step), modelId ("${modelId}")
- Plan must have between 2 and ${this.cfg.maxSequentialSteps} steps
- Each step should build on the previous one${isLargeDoc ? '\n- Step 1 MUST be a "Data Cruncher" step: condense the document to key facts (~2000 chars). Subsequent steps analyze the condensed summary.' : ''}
- The FINAL step is the synthesizer: it must produce a cohesive, conversational response incorporating all prior step findings
- Keep system prompts concise but specific to each step's goal

CRITICAL RULE — DO NOT OVER-DECOMPOSE NARRATIVE TASKS:
If the user asks for a comprehensive evaluation, report, essay, or summary of a document, DO NOT break it into multiple sequential steps (e.g., do not separate "parsing", "analyzing", and "synthesizing" into different steps).
These are cohesive narrative tasks that should be handled in a SINGLE step or by falling back to standard generation (return empty array).
Only use multiple steps if the task requires distinctly separate analytical phases with different outputs (e.g., "Extract financial data" THEN "Check compliance against BI regulations").

User request: ${input.refinedPrompt}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      const command = new ConverseCommand({
        modelId,
        messages: [{ role: 'user' as const, content: [{ text: systemPrompt }] }],
        inferenceConfig: { maxTokens: 4096, temperature: 0.2 },
      });

      const response = await bedrockClient.send(command, { abortSignal: controller.signal });
      clearTimeout(timeout);

      const text = response.output?.message?.content?.[0]?.text ?? '';
      const plan = this.parsePlan(text, modelId);

      if (!plan || plan.steps.length < 2) {
        console.warn('[seq-reasoning] Planner: invalid/empty plan');
        return null;
      }

      return plan;
    } catch (err: unknown) {
      console.warn('[seq-reasoning] Planner failed:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /** Parse planner LLM response into SequentialPlan. */
  private parsePlan(text: string, defaultModelId: string): SequentialPlan | null {
    try {
      // Find JSON block in response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);

      if (!Array.isArray(parsed.steps) || parsed.steps.length < 2) return null;

      const steps: SequentialStep[] = parsed.steps.map((s: any, i: number) => ({
        order: i + 1,
        name: s.name || `Step ${i + 1}`,
        description: s.description || '',
        systemPrompt: s.systemPrompt || 'Continue the analysis.',
        modelId: s.modelId || defaultModelId,
      }));

      // Enforce max steps
      const capped = steps.slice(0, this.cfg.maxSequentialSteps);

      return {
        steps: capped,
        reasoning: parsed.reasoning || '',
      };
    } catch {
      return null;
    }
  }

  // ── Step Execution ────────────────────────────────────────────

  /** Build step prompt = step system prompt + accumulated context. */
  private buildStepPrompt(step: SequentialStep, accumulatedContext: string, simplified: boolean): string {
    if (simplified) {
      // Strip formatting, keep essential context
      const trimmed = accumulatedContext.length > 8000
        ? accumulatedContext.slice(-8000)
        : accumulatedContext;
      return `Continue from previous steps.\n\n${trimmed}\n\nNow: ${step.description}`;
    }

    return `${step.systemPrompt}\n\nPrevious context:\n${accumulatedContext || 'No prior context available.'}`;
  }

  /** Call Bedrock for a single step (non-streaming). Returns step output text. */
  private async callStepModel(step: SequentialStep, prompt: string, language?: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);

    try {
      const system: { text: string }[] = [];
      if (language) {
        system.push({ text: `IMPORTANT: Respond in ${language}. Use the same language as the user's original request.` });
      }
      const command = new ConverseCommand({
        modelId: step.modelId,
        messages: [{ role: 'user' as const, content: [{ text: prompt }] }],
        system: system.length > 0 ? system : undefined,
        inferenceConfig: { maxTokens: STEP_MAX_TOKENS, temperature: 0.3 },
      });

      const response = await bedrockClient.send(command, { abortSignal: controller.signal });
      return response.output?.message?.content?.[0]?.text ?? '';
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Synthesizer (always-execute final layer) ───────────────────

  private async synthesizer(
    input: SequentialReasoningInput,
    plan: SequentialPlan,
    accumulatedContext: string,
    stepResults: StepResult[],
    _res: Response,
  ): Promise<string> {
    const completedCount = stepResults.filter(r => r.status === 'success').length;
    const skippedSteps = stepResults.filter(r => r.status === 'failed' || r.status === 'skipped')
      .map(r => `Step ${r.order}: ${r.errorMessage || 'failed'}`);

    let synthPrompt: string;

    if (completedCount === 0) {
      // All steps failed — fallback to direct response
      synthPrompt = `The user asked: ${input.refinedPrompt}\n\nPlease provide a direct, comprehensive response.`;
    } else {
      const gaps = skippedSteps.length > 0
        ? `\n\nNote: The following steps could not complete:\n${skippedSteps.join('\n')}\n\nAcknowledge these gaps and provide the best response possible.`
        : '';

      const skill = input.routingDecision?.skill || 'fallback';
      const { getDefaultFormatTemplate } = await import('./routing-engine.service.js');
      const formatTemplate = getDefaultFormatTemplate(skill) || input.routingDecision?.contract?.output_format;
      const formatInstruction = formatTemplate
        ? `\n\nFollow this output structure:\n${formatTemplate}`
        : '';

      synthPrompt = `You are answering the user based on step-by-step analysis findings.

User's original request:
${input.refinedPrompt}

Completed steps: ${completedCount}/${stepResults.length}
${gaps}

Step findings:
${accumulatedContext}

Produce a focused response that answers the user's request directly. Use the findings as evidence.${formatInstruction}`;
    }

    const modelId = this.resolveModel(input.routingDecision);
    const lang = input.routingDecision?.detectedLanguage;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);

      const system: { text: string }[] = [];
      if (lang) {
        system.push({ text: `IMPORTANT: The user's original request was in ${lang}. Respond in ${lang}.` });
      }
      const command = new ConverseCommand({
        modelId,
        messages: [{ role: 'user' as const, content: [{ text: synthPrompt }] }],
        system: system.length > 0 ? system : undefined,
        inferenceConfig: { maxTokens: STEP_MAX_TOKENS, temperature: 0.3 },
      });

      const response = await bedrockClient.send(command, { abortSignal: controller.signal });
      clearTimeout(timeout);
      return response.output?.message?.content?.[0]?.text ?? (accumulatedContext || input.refinedPrompt);
    } catch (err: unknown) {
      console.error('[seq-reasoning] Synthesizer error:', err instanceof Error ? err.message : String(err));
      // Return what we have
      return accumulatedContext || input.refinedPrompt;
    }
  }

  // ── Progressive Synthesis ──────────────────────────────────────

  /** Emit interim synthesis every N steps using cheap model (qwen3-32b). */
  private async emitInterimSynthesis(
    res: Response,
    accumulatedContext: string,
    step: SequentialStep,
    total: number,
  ): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);

      const command = new ConverseCommand({
        modelId: 'qwen.qwen3-32b-v1:0',
        messages: [{
          role: 'user' as const,
          content: [{ text: `Summarize the key findings so far in 2-3 sentences:\n\n${accumulatedContext}` }],
        }],
        inferenceConfig: { maxTokens: INTERIM_MAX_TOKENS, temperature: 0.1 },
      });

      const response = await bedrockClient.send(command, { abortSignal: controller.signal });
      clearTimeout(timeout);

      const insight = response.output?.message?.content?.[0]?.text ?? '';

      if (insight.trim()) {
        res.write(`event: orchestration_interim\ndata: ${JSON.stringify({
          step: step.order,
          total,
          insight,
        })}\n\n`);
      }
    } catch {
      // Progressive synthesis is best-effort — silence errors
    }
  }

  // ── SSE Emitters ──────────────────────────────────────────────

  private emitPlanEvent(res: Response, plan: SequentialPlan): void {
    res.write(`event: orchestration_plan\ndata: ${JSON.stringify({
      steps: plan.steps.map(s => ({ order: s.order, name: s.name, description: s.description })),
      reasoning: plan.reasoning,
    })}\n\n`);
  }

  private emitStatusEvent(
    res: Response,
    step: SequentialStep,
    total: number,
    status: OrchestrationStatusEvent['status'],
    durationMs?: number,
  ): void {
    const event: OrchestrationStatusEvent = {
      step: step.order,
      total,
      name: step.name,
      description: step.description,
      status,
      durationMs,
    };
    res.write(`event: orchestration_status\ndata: ${JSON.stringify(event)}\n\n`);
  }

  // ── Helpers ───────────────────────────────────────────────────

  private resolveModel(rd: RoutingDecision): string {
    // Use executed model from routing, default to qwen3-235b
    return rd.executedModelId || 'qwen.qwen3-235b-a22b-2507-v1:0';
  }

  /** Rough token estimate: ~4 chars per token. */
  private estimateTokens(text: string): number {
    return Math.ceil((text?.length || 0) / 4);
  }
}

/**
 * Strip markdown artifacts from text while preserving readability.
 * Only applied to non-code skills (code responses may contain intentional markdown).
 */
export function stripMarkdownArtifacts(text: string, skill?: string): string {
  // Skip cleanup for code-related skills
  if (skill === 'code' || skill === 'log_troubleshooting') return text;

  const cleaned = text
    // Preserve section structure: convert markdown headings to bold
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    // Remove horizontal rules
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    // Remove bold markers but keep content
    .replace(/\*\*(.*?)\*\*/g, '$1')
    // Remove italic markers but keep content
    .replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '$1')
    // Remove inline code backticks
    .replace(/`([^`]+)`/g, '$1')
    // Remove strikethrough
    .replace(/~~(.*?)~~/g, '$1')
    // Remove markdown link syntax but keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

export const sequentialReasoner = new SequentialReasoner();
