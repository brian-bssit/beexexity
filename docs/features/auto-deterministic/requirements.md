# Auto Mode → Deterministic Fixed-Model (Tahap 1)

## Overview

Tahap 1 of the routing simplification. Today, `routingState === 'auto'` runs an expensive LLM pipeline
(`unifiedClassifyAndScore` → `refinePrompt` → complexity scoring → policy) and — for complexity ≥ 4 —
`sequentialReasoner`. Goal: make **Auto** behave exactly like the current **manual "Qwen3 235B"**
selection: one deterministic model, raw prompt, knowledge retrieval active, no LLM routing calls,
no sequential reasoning.

This doc removes the auto-path LLM routing engine and disables sequential reasoning **entirely**
(no length-threshold replacement). Manual and passthrough states are preserved byte-for-byte where
observable. Knowledge retrieval (Tier 2) stays wired on the JSON text path exactly as today — it is
the point of the change. Phase 2 — the deterministic **sovereign-tier** router + external Tier-3
provider — is now implemented in [`docs/features/sovereign-tier-router/`](../sovereign-tier-router/);
it injects into `selectAutoModel` via `classifySovereignTier()` + the `tier3-candidate` flag, keeping
`reasonCode` + `flags` as its seam.

## Glossary

| Term | Meaning |
|---|---|
| Auto state | No model selected by user → server decides. |
| Manual state | User picked a specific model from the dropdown. |
| Passthrough | Global admin toggle → raw prompt, minimal system prompt. |
| `selectAutoModel` seam | New deterministic function that picks the model for Auto (the future Tier-3 injection point). |
| Sequential reasoning | `sequentialReasoner` multi-step executor + planner + orchestrator SSE. Removed in Tahap 1. |
| Knowledge retrieval | Tier 2 RAG — hybrid pgvector search injected into the system prompt with citations. |

## Requirements

### Req 1.1 — Auto = deterministic flag model
**User story:** As a user on Auto mode, I want the same experience as today when I manually select
Qwen3 235B.

**Acceptance criteria:**
- WHEN `routingState === 'auto'` AND no images THEN the executed model is the configured flag
  `AUTO_MODEL_ID` (default `qwen.qwen3-235b-a22b-2507-v1:0`) — deterministic, no LLM routing calls.
- WHEN the auto request completes THEN the answer matches today's manual-Qwen3-235B behavior:
  raw (PII-masked) prompt used verbatim, knowledge retrieval active, fallback role/format.
- WHEN the configured auto model is not accessible to the user (private + not whitelisted)
  THEN fall back silently to `DEFAULT_MODEL` with flag `auto-access-denied` — no 403 on Auto.
- THEN the whole routing step performs **zero** Bedrock routing LLM calls (no classify/refine/score).

### Req 1.2 — No sequential reasoning anywhere
**User story:** As a system operator, I want sequential reasoning gone completely.

**Acceptance criteria:**
- WHEN any request arrives (any state, any prompt length, any model) THEN the sequential reasoner
  never runs.
- THEN the sequential-reasoning execution branch, service, orchestration SSE events, and orchestration
  audit writes are removed.
- THEN `seqInput`/`orchestrationMeta` wiring is deleted from both the JSON and multipart handlers.
- THEN `tests/unit/sequential-reasoning.test.ts` and its fixtures are removed.

### Req 1.3 — Auto LLM routing engine removed
**User story:** As a maintainer, I want the auto-path LLM machinery gone, not dormant.

**Acceptance criteria:**
- THEN `unifiedClassifyAndScore`, `refinePrompt`, `validateSkillInvariants`, and per-skill refinement
  prompts are deleted.
- THEN `PromptContract` production, ambiguities injection, and the discovered-roles write hook are deleted.
- THEN downstream consumers that only ever fired on a non-null contract are removed: `verifyOutput`,
  `semanticJudge`, `repairResponse` (and their SSE events `verification`, `semantic_verdict`, `repair`).
- THEN per-skill format templates, per-skill few-shot examples, and the 23-skill taxonomy/types are
  removed; only `fallback` entries (used by manual + passthrough) remain.
- THEN the multi-path auto build in `routeRequest` is replaced by `selectAutoModel`.

### Req 1.4 — Manual & passthrough preserved
**User story:** As a user who picks a model, or as an operator toggling passthrough, nothing changes.

**Acceptance criteria:**
- WHEN a user selects a model THEN manual executes that model with raw prompt, model-access check,
  fallback role/format — identical to today.
- WHEN global passthrough is on THEN passthrough path is unchanged (raw prompt, minimal system prompt).
- THEN observable UI text for manual/passthrough (status panel model + reason) stays correct after the
  SSE `routing` payload trim.

### Req 1.5 — Knowledge retrieval unaffected & used by Auto
**User story:** As a user asking Auto a question covered by ingested knowledge, I want the grounded answer.

**Acceptance criteria:**
- WHEN Auto mode runs on the JSON text path THEN `knowledgeSearch` executes on the raw masked prompt
  (previously the refined prompt) and retrieved chunks + citations are injected — same as manual Qwen3-235B.
- THEN the `embedding` SSE event, `knowledge_sources` audit trace, and 2s self-timeout degrade-to-`[]`
  behavior are unchanged.
- THEN the multipart upload path remains out of knowledge scope (unchanged from today).

### Req 1.6 — Routing decision trimmed to reasonCode + flags
**User story:** As a future Phase-2 implementer, I want a stable seam to inject Tier 3.

**Acceptance criteria:**
- THEN `routeRequest` (auto branch) returns a decision carrying `executedModelId`,
  `routingState`, `routingReasonCode`, `flags`, `modalityFlags` — skill/score/contract fields are no
  longer populated from LLM output.
- THEN the SSE `routing` event payload and audit fields that referenced removed concepts
  (skill, complexity, scoreBand, contract) are dropped or stubbed to their manual defaults.
