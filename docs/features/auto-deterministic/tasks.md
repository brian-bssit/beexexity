# Tasks — Auto Mode → Deterministic Fixed-Model (Tahap 1)

Traceability: each checkbox → requirement (Req x.y). Small tasks — apply the 7-Step Execution Ladder.

## Wave 1 — Config & seam [Req 1.1]

- [x] 1. `src/config/index.ts`: add `routing.autoModelId` = env `AUTO_MODEL_ID`, default
      `qwen.qwen3-235b-a22b-2507-v1:0`. [Req 1.1]
- [x] 2. `src/services/inference.service.ts`: `export` the existing `checkModelAccess` (currently
      private, ~line 218) so the seam can reuse it — no SQL duplication. [Req 1.1]
- [x] 3. `src/services/routing-engine.service.ts`: add `selectAutoModel(ctx)`:
      `modelId = config.routing.autoModelId`; if `!await checkModelAccess(userId, modelId)` →
      return `{ modelId: DEFAULT_MODEL, reasonCode: 'auto-access-denied', flags: ['auto-access-denied'] }`;
      else `{ modelId, reasonCode: 'auto-fixed-model', flags: [] }`. [Req 1.1]
- [x] 4. `routing-engine.service.ts`: rewrite `routeRequest()` **auto** branch to call
      `selectAutoModel` and return a decision with `complexityScore: 0`, `skill: 'fallback'`,
      `contract: null`, `refinedPrompt: input.originalPrompt` — zero LLM routing calls.
      Manual + passthrough branches untouched. [Req 1.1, 1.4, 1.6]

## Wave 2 — Kill sequential reasoning [Req 1.2]

- [x] 5. Delete `src/services/sequential-reasoning.service.ts`. [Req 1.2]
- [x] 6. `src/routes/inference.routes.ts` JSON handler: remove `sequentialReasoner` import, the
      `complexityScore>=4` seq branch (~803-833), `let orchestrationMeta` (~793), and the post-seq
      `done` re-emit guard (~904-906). Single-shot `generate()` is now the only dispatch. [Req 1.2]
- [x] 7. `src/routes/inference.routes.ts` multipart handler: same removals — seq branch (~1572-1600),
      `orchestrationMeta` (~1564), seq-gated `done` re-emit (~1717). [Req 1.2]
- [x] 8. Audit calls in both handlers: drop `orchestrationMeta` argument. [Req 1.2]
- [x] 9. Delete `tests/unit/sequential-reasoning.test.ts`. [Req 1.2]
- [x] 10. `src/config/index.ts`: delete orchestration keys used only by seq —
      `maxSequentialSteps`, `orchestrationTimeoutMs`, `stepRetryCount`, `progressiveInterval`.
      **Keep** `largeDocumentThreshold` (still read at `inference.routes.ts:1486` for OCR truncation). [Req 1.2]
- [x] 11. `public/index.html`: remove `orchestration_status` SSE handlers and sequential-progress UI
      (the `spec.skill` orchestration branches + `window._debugEvents` orchestration pushes). [Req 1.2]

## Checkpoint — ensure tests pass (before Wave 3 cleanup)

- [x] 12. `npm run build` clean; `npm test` green (now excludes sequential-reasoning tests). [checkpoint]

## Wave 3 — Cascade cleanup [Req 1.3, 1.6]

- [x] 13. `routing-engine.service.ts`: delete `unifiedClassifyAndScore`, `refinePrompt`,
      `parseRefinementContract`, `extractSkill`, `validateSkillInvariants`, discovered-roles write hook,
      contract/role-merge code, and the per-skill refinement prompt builders. [Req 1.3]
- [x] 14. `src/routes/inference.routes.ts` both handlers: contract is now always `null`, so delete the
      verification/semantic/repair blocks (verifier ~839-899, semantic/repair in multipart) and their
      SSE writes (`verification`, `semantic_verdict`, `repair`) + imports `verifyOutput`,
      `semanticJudge`, `repairResponse`. [Req 1.3]
- [x] 15. Ambiguities injection block (JSON ~695-699, contract-gated) is dead → delete. [Req 1.3]
- [x] 16. Few-shot: skill is always `'fallback'` and `FEW_SHOTS` has no `fallback` key →
      `getFewShotExamples` always returns `[]`. Remove the injection calls (~712, ~1554) and delete
      `src/services/few-shot-library.ts` (+ its `SkillType` usage). [Req 1.3]
- [x] 17. `src/config/skill-role-map.ts`: trim to `fallback: 'General Purpose Assistant'` (keep the
      function + export so `inference.routes` system-prompt build keeps working). [Req 1.3]
- [x] 18. `routing-engine.service.ts`: `getDefaultFormatTemplate`/`STRUCTURED_SKILLS` now only ever
      answer `null` for `'fallback'` → remove the function + its call sites (role falls back to
      `FORMAT_INSTRUCTION`, identical to today's manual output). [Req 1.3]
- [x] 19. `src/types/routing.types.ts`: remove `PromptContract`, `VerificationViolation`,
      `VerificationResult`; reduce `SkillType`/`ALL_SKILLS` to `'fallback'` (or remove if no consumer).
      Keep `RoutingInput`/`RoutingDecision`/`ModalityFlags` shapes; `routingReasonCode`/`flags` remain
      the extensible seam. [Req 1.3, 1.6]
- [x] 20. `src/types/inference.types.ts`: trim `RoutingMetadataEvent` — drop `skill`, `complexityScore`,
      `scoreBand`, `contract`, and the `_classRaw`/`_refinementRaw`-style debug fields. [Req 1.6]
- [x] 21. `src/routes/inference.routes.ts`: SSE `routing` payload (~648-693) rebuilt from the trimmed
      event type; drop `skill`/`complexity`/`contract`/raw-LLM fields, keep `routingState`,
      `executedModelId`, `routingReasonCode`, `flags`, `modalityFlags`, timing. [Req 1.6]
- [x] 22. `public/index.html`: SSE `routing` handler — remove `Skill:`/`Complexity:` rows (always
      fallback/0); keep Model + Reason rendering. [Req 1.6]
- [x] 23. `src/services/audit.service.ts` + call sites: remove `complexityScore`, `reasoningSummary`,
      `routingContext`, `routingIntent` params and SQL columns' values (columns stay NULL — no migration). [Req 1.6]
- [x] 24. Update `tests/unit/routing-engine.test.ts`: replace 24-skill/invariant/refinement assertions
      with `selectAutoModel` deterministic tests (fixed default, access-denied fallback, no-LLM-call). [Req 1.1]

## Checkpoint — ensure tests pass

- [x] 25. `npm run build` clean; `npm test` green; verify `routing-engine.test.ts` rewritten. [checkpoint]
- [ ] 26. Manual smoke: server up → Auto question on ingested knowledge returns grounded answer
      (embedding SSE event + citation); Auto plain question single-shot; manual model select unchanged;
      passthrough unchanged. [Req 1.4, 1.5]

## Deferred (NOT in Tahap 1)

- [ ] (future) `migrations/016` `discovered_roles` table cleanup pass (tab + endpoints sudah dihapus).
- [x] (done in `sovereign-tier-router/`) Phase 2: sovereign-tier router + external Tier-3 provider
      → injects into `selectAutoModel` (`classifySovereignTier`, `tier3-candidate`/`sovereign-tier-3`).
