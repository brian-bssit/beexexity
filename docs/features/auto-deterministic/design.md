# Design — Auto Mode → Deterministic Fixed-Model (Tahap 1)

## Architecture

Today the request flow (JSON text path) is:

```
maskedPrompt → contextOutput (buildContext)
  → routingState ∈ {passthrough, auto, manual}
  → auto: routeRequest() = unifiedClassifyAndScore → refinePrompt → complexity → resolvePolicy
  → complexity ≥ 4 & auto → sequentialReasoner.execute()
  → knowledgeSearch(effectivePrompt) → buildKnowledgeSection()
  → generate() single-shot
```

After Tahap 1:

```
maskedPrompt → contextOutput (buildContext)
  → routingState ∈ {passthrough, auto, manual}
  → auto: selectAutoModel() → fixed model + reasonCode/flags   [zero LLM routing calls]
  → generate() single-shot                                      [sequential reasoner gone]
  → knowledgeSearch(raw maskedPrompt) → buildKnowledgeSection() [unchanged]
```

Model selection collapses to one deterministic decision point. Both the JSON and the multipart
handler already funnel auto through `routeRequest()`; that function's auto branch becomes the seam.

## Components & Interfaces

### `selectAutoModel(ctx)` — new seam (replaces LLM auto routing)

```ts
interface AutoModelContext {
  userId: string;
  hasImages: boolean;          // reserved for Phase-2 gate ordering — unused in Tahap 1
  manualModelId?: undefined;   // auto never carries one
}

interface AutoModelSelection {
  modelId: string;
  reasonCode: string;          // 'auto-fixed-model' | 'auto-access-denied'
  flags: string[];             // e.g. [] or ['auto-access-denied']
}

function selectAutoModel(ctx: AutoModelContext): AutoModelSelection
```

Behavior:
1. `modelId = config.routing.autoModelId` (env `AUTO_MODEL_ID`, default `qwen.qwen3-235b-a22b-2507-v1:0`).
2. If `modelId` is restricted (has `user_model_access` rows) and `ctx.userId` is not whitelisted →
   return `DEFAULT_MODEL` (`qwen.qwen3-32b-v1:0`), reasonCode `'auto-access-denied'`,
   flags `['auto-access-denied']`. Silent fallback — matches manual-mode fail-soft expectations, no 403.
3. Access reuses the existing async `checkModelAccess(userId, modelId)` (currently private in
   `inference.service.ts`). **Export it** from a shared home rather than duplicating SQL.

Why here and not `validateModelId`: manual keeps its current throw-on-403; auto must degrade silently.
`checkModelAccess` is the shared primitive; `validateModelId` continues to throw for manual.

### `routeRequest()` — simplified

Auto branch rewritten to:

```ts
if (input.routingState === 'auto') {
  const sel = await selectAutoModel({ userId: input.userId, hasImages: input.hasImages });
  return {
    executedModelId: sel.modelId,
    routingState: 'auto',
    routingReasonCode: sel.reasonCode,
    flags: sel.flags,
    modalityFlags,                 // unchanged helper
    manualOverrideApplied: false,
    refinedPrompt: input.originalPrompt,  // raw — no refinement
    confidence: 1.0,
    complexityScore: 0,            // keep field for type-shape compat; always 0
    scoreBand: 'direct-answer',
    skill: 'fallback',             // fixed — drives role/format fallbacks downstream
    contract: null,
    sessionContext: input.originalPrompt.slice(0, 120),
  };
}
```

Manual and passthrough branches inside `routeRequest` are untouched. The caller (`inference.routes.ts`)
keeps its existing inline manual/passthrough decision objects — no caller-level behavioral change.

### Deletions

**`src/services/routing-engine.service.ts`** — delete: `unifiedClassifyAndScore`, `refinePrompt`,
`parseRefinementContract`, `extractSkill`, `validateSkillInvariants`, `scoreToBand` (if unused after
score removal), all per-skill refinement prompt builders, discovered-roles write hook, skill-role
merge logic, `PromptContract` construction. Keep: `routeRequest`, `selectAutoModel` (new),
`verifyOutput` **only if** still referenced — see cascade below, `_setBedrockClient`/`_bedrockClient`.

**`src/services/sequential-reasoning.service.ts`** — delete the whole file.

**`src/types/routing.types.ts`** — delete `PromptContract`, `VerificationViolation`,
`VerificationResult`; trim `SkillType`/`ALL_SKILLS` to `'fallback'` only (or remove if no remaining
consumer); keep `RoutingInput`/`RoutingDecision`/`ModalityFlags` shapes (fields above become fixed).
Keep optional legacy fields typed so audit/SSE serialization does not break.

**`src/routes/inference.routes.ts`** — both handlers:
- Remove `sequentialReasoner` import + seq branch + `seqResult`/`orchestrationMeta` writes + the
  post-seq manual `done` re-emit (done is emitted inside `generate`/unified dispatch).
- The `complexityScore >= 4` guard is always false once auto sets 0 → the seq branch becomes dead;
  delete it (Req 1.2), not just skip it.
- Verifier/semantic/repair block is gated on `routingDecision?.contract` — contract is now always
  `null`, so delete the whole block + the `verifyOutput`/`semanticJudge`/`repairResponse` imports and
  their SSE writes (`verification`, `semantic_verdict`, `repair`).
- Keep `getFewShotExamples`, `getRoleForSkill`, `getDefaultFormatTemplate` calls — skill is always
  `'fallback'`, which is exactly today's manual behavior.

**`src/services/few-shot-library.ts`, `src/config/skill-role-map.ts`** — trim to the `'fallback'`
entry + return-empty default only (Req 1.3). Delete per-skill example pairs and 22 non-fallback roles.

**`public/index.html`** — SSE `routing` handler: drop `Skill:`/`Complexity:` rows (they show
`fallback`/`0`); keep Model + Reason. Remove the `orchestration_status` handlers, the sequential
progress UI (`window._debugEvents` orchestration branches). Keep `semantic_verdict`/`verification`
cleanup only if removal doesn't strand other logic — they no longer fire; delete.

**`src/services/audit.service.ts`** + call sites — remove `complexityScore`, `reasoningSummary`,
`routingContext`/`routingIntent` (contract-derived), `orchestrationMeta` params. Keep
`routingState`, `routingReasonCode`, `executedModelId`, `routingFlags`, `knowledgeSourceIds`,
`embeddingInputTokens`. (audit_logs columns stay — no migration; unused columns are simply NULL.)

**`src/config/index.ts`** — add `routing.autoModelId` (env `AUTO_MODEL_ID`, default qwen3-235b).
Remove orchestration knobs only used by sequential reasoning: `maxSequentialSteps`,
`orchestrationTimeoutMs`, `stepRetryCount`, `progressiveInterval`. **Keep** `largeDocumentThreshold`
— it is still read at `inference.routes.ts:1486` for OCR text truncation.

**`src/routes/feedback.routes.ts` / admin filter** — feedback rows may carry `routing_metadata.skill`;
the admin list filter param `?skill=` continues to work against legacy rows (no migration). No code
change required; note only.

**`src/types/inference.types.ts`** — `RoutingMetadataEvent`: drop `skill`, `complexityScore`,
`scoreBand`, `contract`, LLM-raw debug fields (`_classificationRaw`, `_refinementRaw`, …).
Trim `AuditLogParams`-equivalent shapes to match audit deletion.

### Known keepers / non-goals
- `src/routes/generation.routes.ts`, `src/services/cost-reporting.service.ts`,
  `src/services/session-memory.service.ts`, sub-agent orchestration tables — untouched.
- `migrations/016` (discovered_roles): **deferred** — table + migration stay (no write hook, no consumers);
  drop both only in a later cleanup pass. Admin tab + endpoints already removed.
- The multipart path's `finalExecutedModelId` override logic (vision / OCR / PPTX) stays as-is;
  only its seq branch and contract-gated verification are removed.

## Data Models

No schema migration. Config only:

| Env | Default | Meaning |
|---|---|---|
| `AUTO_MODEL_ID` | `qwen.qwen3-235b-a22b-2507-v1:0` | Model used when routingState = auto |

## Error Handling

| Scenario | Behavior |
|---|---|
| `AUTO_MODEL_ID` invalid / not in `ALLOWED_MODELS` | `selectAutoModel` treats as no-restriction → returns raw value; downstream `resolveModelForInvocation` throws as today (config bug surfaces loudly in logs). Not masked. |
| Auto model is private, user not whitelisted | Silent fallback to `DEFAULT_MODEL` + flag `auto-access-denied`, reasonCode `'auto-access-denied'`. No 403. |
| `checkModelAccess` throws (DB down) | Same as today's fail-closed: returns false → fallback to DEFAULT_MODEL for auto. |
| Knowledge retrieval failure | Unchanged — 2s self-timeout, degrade to `[]`, never blocks inference. |
| Sequential reasoning previously would have run | Never runs. Requests that used it become single-shot `generate()` on the same routed model. |

## SSE event payload after Tahap 1

| Event | Now carries |
|---|---|
| `routing` | `{ routingState, executedModelId, routingReasonCode, flags, modalityFlags, manualOverrideApplied, timing }` — no skill/score/contract |
| `embedding` | unchanged |
| `done` / `error` / `session` / `session_status` | unchanged |
| `verification` / `semantic_verdict` / `repair` / `orchestration_status` | never emitted |
