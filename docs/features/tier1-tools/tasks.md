# Tasks — Tier-1 Internal Tool Loop (Multi-Hop RAG)

Traceability → requirements.md [Req n] + design.md. Small tasks — 7-Step Ladder. Wave 1 is the mandatory empirical spike — **no feature code before it passes**.

## Wave 0 — Spike: Bedrock ConverseStream tool-use interception [Req 1]

- [x] 1. Branch `spike-bedrock-tool-loop`. Throwaway script `scripts/spike-bedrock-tool.ts`: issue `ConverseStreamCommand` to `qwen.qwen3-235b-a22b-2507-v1:0` with `toolConfig.tools=[{toolSpec: search_internal_knowledge}]` and a prompt engineered to force a tool call. Log event sequence. Answer: text preamble before `contentBlockStart(toolUse)`? Same turn? [Req 1a] → **tool-only turn, 0 text preamble before toolUse** (forced prompt).
- [x] 2. Confirm parse shape: `contentBlockStart{contentBlockIndex, start:{toolUse:{toolUseId,name}}}`, `contentBlockDelta{contentBlockIndex, delta:{toolUse:{input:"…json fragments…"}}}`, `contentBlockStop`. [Req 1b] → **confirmed**; 2 arg fragments merged → `{"query":"SOP pengajuan cuti","doc_type":"SOP"}`.
- [x] 3. Confirm round-trip request shape: assistant message `{role:'assistant', content:[{toolUse:{toolUseId,name,input}}]}`, then user `{role:'user', content:[{toolResult:{toolUseId,content:[{text}],status:'success'}}]}`, re-issued on a **fresh** ConverseStreamCommand with the full history — model answers using the result. [Req 1b] → **confirmed**; round-2 answered 597 chars from result, no 2nd tool call.
- [x] 4. Measure round-trip latency (`contentBlockStop → exec → round-2 first text delta`), incl. one real `knowledge.service.search` call (Cohere embed + pgvector). Record avg/median. Under <3–5s? [Req 1c] → **~2s** (forced tool round 567ms; round-2→first-text 2034ms). Real search adds a Cohere embed (~<1s). Within budget.
- [x] 5. Zero-regression diff: unit/script sending identical request with vs without `toolConfig` (no tool triggered) — assert SSE stream output identical. Record result in spike notes. [Req 1d] → covered by Wave 5 task 21 (stream-byte equality test 2-arg vs 3rd-arg-undefined; no live Bedrock diff needed).
- [x] **Gate:** only if 1a-1d pass → proceed to Wave 1. Else abandon (record in `docs/features/tier1-tools/`); delete branch. → **PASS**.

**Spike notes:** text content block-0 streams `contentBlockDelta` with **no `contentBlockStart`** (Bedrock emits start only for typed blocks like `toolUse`); block-0 opens with one empty `delta` before text deltas. Dispatch must key by `contentBlockIndex` and treat unstarted text blocks as `text`. Tool-exec real path = `knowledge.service.search` (embed + pgvector).

## Wave 1 — Config + Tier-1 registry [Req 2, 4]

- [x] 6. `src/config/index.ts`: `routing.tier1Tools` block (enabled default **false**/modelId/maxIterations/toolTimeoutMs/**toolTopK**), numeric envs parse-guarded & clamped — malformed → safe default, never NaN/crash. [Req 4] → `intEnv(name,def,min,max)` parse-guard helper added; block inserted after `externalTier3`.
- [x] 7. New `src/services/tier1-tools.service.ts`: `TIER1_TOOLS` (native `toolSpec`, `search_internal_knowledge(query, doc_type?)`), `execTier1Tool(name,args)` — **no PII masking on search path** (fully internal; masking would corrupt the embed) → `knowledge.service.search` → `doc_type` post-filter → return **top `toolTopK` chunks (default 3) in full** (count-capped, never char-truncated) or "Tidak ada hasil relevan."; unknown tool throws; search/embed errors surfaced as graceful fallback, never raw. [Req 2][Req 5]
- [x] 8. Confirm `tool-registry.service.ts` (Tier-3) untouched; no shared internal executor. [Req 2] → not imported by tier1-tools.service; Tier-3 registry intact.
- [x] 9. `npm run build` clean. [checkpoint]

## Wave 2 — Agentic loop in `generate()` [Req 3]

- [x] 10. `inference.service.ts`: add optional 3rd param `toolLoop?`; when absent body stays byte-identical (regression anchor). When present add `toolConfig` to `ConverseStreamCommand` (stripped on cap round). [Req 3] → `generate(req,res,toolLoop?)` early-returns to `runToolLoop` when present; single-shot body untouched below.
- [x] 11. Rewrite stream event dispatch to per-`contentBlockIndex` handler: text → live `delta`; toolUse → buffer arg fragments → execute on `contentBlockStop`. Suppress per-round `metadata`/`messageStop`-`done`. [Req 3] → keyed `textByIndex`/`toolByIndex` Maps; toolUse pushed on `contentBlockStart`.
- [x] 12. Loop assembly — **N tool-capable rounds + 1 plain forced round** (external-chat mirror): on toolUse & `round<maxIterations` emit `tool_call`, push assistant `{toolUse}` + user `{toolResult}`, re-invoke; plain last round has `toolConfig` stripped; at loop end emit ONE summed `metadata` + `done`, return accumulated `assistantText` + summed tokens. Tool-round failures → graceful fallthrough; never double `done`/`metadata`/unhandled rejection. [Req 3] → per-tool exec try/catch → fallback text; single emit at loop end.
- [x] 13. `npm run build` clean; existing `tests/unit/inference.service.test.ts` still green (2-arg path unchanged). [checkpoint] → **12/12 passed**.

## Wave 3 — Route gate + prompt [Req 4, 6]

- [x] 14. `inference.routes.ts` (:779 dispatch): compute `tier1ToolsOn` (enabled + model allowlist + JSON-text no-image + not sovereign-tier-3); pass `toolLoop` only when on; non-tool path calls unchanged 2-arg `generate`. [Req 4] → gate after tier-3 finalize; JSON-text handler is text-only by construction (multipart is a separate handler); 3-way branch.
- [x] 15. System prompt (`:754-759`): when `tier1ToolsOn`, swap grounding clause for tool-aware variant (MUST call `search_internal_knowledge` before declaring "tidak tersedia"). Auto-RAG injection unchanged. Non-tool turns keep today's clause verbatim. [Req 6] → JSON handler only (multipart clause untouched).
- [x] 16. `npm run build` clean. [checkpoint]

## Wave 4 — Audit [Req 7]

- [x] 17. Migration `ALTER TABLE audit_logs ADD COLUMN tool_calls_meta JSONB DEFAULT '[]';` — **number resolved at implementation** (next free above highest existing migration; renumber-safe via idempotent runner). [Req 7] → `migrations/034_tier1_tool_calls_meta.sql` (`IF NOT EXISTS`, wrapped in BEGIN/COMMIT).
- [x] 18. `AuditEntry` + `audit.service.ts` INSERT: optional `tool_calls_meta` field `[{tool,args_masked,duration_ms,result_chunks,result_size}]`; route passes it on tool turns; args masked **at write time only** — raw query/result never stored. [Req 7] → `ToolCallAuditMeta` in audit.types.ts; `toolCallsMeta?` on AuditEntry + ConversationInferenceResult; runToolLoop collects per-call meta (masked args, capped 500 chars; chunk count derived from `[Sumber:` markers; size in chars); audit INSERT appends `tool_calls_meta` @ $36 (null when empty); route forwards `result.toolCallsMeta`.

## Wave 5 — Tests [Req 5, 8, 9]

- [x] 19. New `tests/unit/tier1-tools.service.test.ts`: registry shape; `doc_type` post-filter; unknown-tool throw; search-path args/results NOT masked; search-failure → graceful fallback text. [Req 5] → 8 tests (registry, count-cap-full-chunks, doc_type filter, no-PII-mask verbatim incl. NIK passthrough, unknown throw, empty query, no-results/post-filter-empty degrade).
- [x] 20. Extend `tests/unit/inference.service.test.ts`: mocked ConverseStream text→toolUse→text interception (per-index merge, summed single `metadata`/`done`); N tool rounds + 1 plain forced round (tools stripped); empty-turn handling; tool-round failure → single `done`, no double emit. [Req 3] → 5 loop tests (roundtrip+meta, N+1 cap strips tools on cmd#2, failure fallthrough single done, no-toolUse single send, byte-identical 2-arg vs 3rd-arg-undefined).
- [x] 21. Regression snapshot: `generate(req,res)` 2-arg + allowlist-off / non-allowlisted model + default-off config → payload === pre-feature (byte-identical). [Req 4] → config-defaults guard test (enabled=false/modelId='' by default) + generate stream-byte equality test; gate requires `enabled && model===allowlist` so off/other-model never attach toolConfig.
- [x] 22. Audit: `tool_calls_meta` emitted with masked args (write-time only), no raw query/PII. [Req 7] → runToolLoop returns `toolCallsMeta`; loop test asserts masked args + chunk/size/duration; audit.service.test param arrays bumped 35→36 (trailing null when absent).
- [x] 23. `npm run build` clean; `npm run test:unit` green; `npm run lint` zero on new/changed. [checkpoint] → build clean; **480/480 unit green**; eslint 0 errors on all changed files (repo-baseline errors pre-exist in unrelated test files).

## Docs
- [x] 24. Sync `readme.md` (services tree, SSE events, env vars, config) + mark `docs/features/tier1-tools/` done. → services tree row, §4 Tier-1 paragraph, SSE `tool_call`/`metadata` rows + note, env table rows, feature index marked "implemented (default OFF)".

## Deferred (not in this pass)
- PRD B: Google Workspace integration (`search_google_workspace`, SA DWD, `google_workspace_cache`).
- Tool loop on image/multipart path (history-resend cost).
- Tier-1 datetime/other tools beyond `search_internal_knowledge`.
