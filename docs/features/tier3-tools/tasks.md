# Tasks — Tier-3 Tools & Thinking (DeepSeek)

Traceability → requirements.md [Req n] + design.md. Small tasks — 7-Step Ladder. Spike ground truth (2026-09-08, `deepseek-v4-flash`) already recorded in req/design — no re-spike needed unless switching model family.

## Wave 1 — Tool registry (datetime PoC) [Req 2]

- [x] 1. Create `src/services/tool-registry.service.ts`: `ToolDefinition`, `AVAILABLE_TOOLS` (one entry `get_current_datetime`, Asia/Jakarta, zero network/DB), `executeTool(name, args) → Promise<string>` (throws on unknown). [Req 2]
- [x] 2. `npm run build` clean. [checkpoint]

## Wave 2 — External-chat ReAct loop [Req 1, 3, 4, 5]

- [x] 3. `external-chat.service.ts`: introduce internal `OpenAIWireMsg` + `mergeToolCalls` (index-based; id/name first-fragment, arguments concatenated per index). Refactor fetch into a per-iteration body builder while keeping the single-attempt error sanitization intact. [Req 3]
- [x] 4. Signature: optional `tools?: ToolDefinition[]` param. Build `body.tools` only when `tools` provided — tools-absent body stays byte-identical to today (regression anchor). No `thinking`/`reasoning_effort` fields ever. [Req 4]
- [x] 5. Parse `delta.reasoning_content` → emit `event: reasoning` per token. No persistence/logging of reasoning text anywhere. [Req 1]
- [x] 6. End-of-turn detection: `hasToolCalls = finish_reason==='tool_calls' || accumulated tool_calls.length>0` at stream end. Merge partial `tool_calls` by index. [Req 3]
- [x] 7. ReAct append: push FULL assistant msg (content + `reasoning_content` verbatim incl `""` + `tool_calls`), `executeTool` per call, push `{role:'tool', tool_call_id, content}`. Cap `MAX_TOOL_ITERATIONS=3`; on cap reached, force a final answer with `tools` stripped. [Req 3]
- [x] 8. Token accounting: accumulate `usage` (final chunk each iteration); if absent → `estimateCharsTokens(messages)` chars/4 fallback. Emit ONE `metadata` (summed) + `done` after loop. [Req 5]
- [x] 9. B1 guard: final iteration `finish_reason==='stop'` && content empty && no tool_calls → throw sanitized `InferenceError('…exhausted reasoning budget…', 'model_error', 502)`; never emit empty `delta`/persist empty. [Req 5]
- [x] 10. `npm run build` clean + existing `tests/unit/external-chat.service.test.ts` still green (tools-absent path unchanged). [checkpoint]

## Wave 3 — Route wiring (minimal) [Req 4]

- [x] 11. `inference.routes.ts` (~778 dispatch): gate `config.routing.externalTier3.toolModelPrefixes` (env `TIER3_TOOL_MODEL_PREFIXES`, default `deepseek-v4-`) → pass `AVAILABLE_TOOLS` + `thinkingParams` (env `TIER3_THINKING_PARAMS`) to `streamExternalCompletion`. Storage/audit code untouched. [Req 4]
- [x] 12. Confirm B1 throw lands in the existing sanitized error SSE path (no success DB row / audit). [Req 5]

## Wave 4 — Frontend additive [Req 6, 7]

- [x] 13. `public/index.html`: handle `reasoning` frames → per-assistant-turn 💭 block; single `role="status"` "Model is thinking…" set on first frame, cleared on first `delta`/`done` (preferred: wrap block in `<details>`); handle `tool_call` → transient `role="status"` badge, removed on next `delta`/`done`. Unknown events ignored. No layout shift / focus trap. [Req 6]
- [x] 14. Verify existing SSE consumers (`delta`/`metadata`/`done`/`session`/`error`) parse unchanged with new events present. [Req 7]

## Wave 5 — Tests [Req 8]

- [x] 15. `tests/unit/external-chat-tools.test.ts` (new): mock fetch sequence tool→final; assert `reasoning_content` echoed verbatim on round 2; partial tool-call index merge; `MAX_TOOL_ITERATIONS` cap (forced answer, tools stripped); summed metadata; allowlist-off → plain body (tools absent); no reasoning in returned/audit-facing payload; **only final non-empty content returned**; B1 empty-content → sanitized error. [Req 8]
- [x] 16. `npm run build` clean; `npm run test:unit` green; `npm run lint` zero on new/changed files. [checkpoint]

## Deferred (not in this pass)
- Exchange-rate tool. `deepseek-v4-pro` spike (thinking opt-in / 400 enforcement). DB-backed per-model tool capability.
