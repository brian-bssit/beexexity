# Requirements — Tier-1 Internal Tool Loop (Multi-Hop RAG)

## Overview

Add agentic **tool calling to the private Tier-1 Bedrock path** (`qwen.qwen3-235b-a22b-2507-v1:0`, JSON text-only) so the model can run **follow-up knowledge searches** (multi-hop) beyond the one-shot Auto-RAG already injected. Auto-RAG and the knowledge-empty → Tier-3 escalation stay **byte-identical** (they are the sovereign router's gatekeeper). The tool loop is an **additive layer**: when the model decides Auto-RAG context is insufficient, it calls `search_internal_knowledge(query, doc_type?)`, receives chunk text back, and continues.

**Non-goals:** Google Workspace (separate PRD B, backlog). Write actions. Any change to the Tier-3 path (`external-chat.service.ts`). Multimodal/image-path tool loop (history resend cost). Removing or weakening Auto-RAG / Tier-3 escalation.

**Ground rule (from design review):** implement & ship behind a model allowlist + `TIER1_TOOLS_ENABLED`. If the loop is unreliable or slow, unset the env → stream stays byte-identical to today. Zero regression is the acceptance bar.

---

## Requirements

### Req 1 — Empirical spike gates all coding
WHEN design work begins, THEN a spike branch (`spike-bedrock-tool-loop`) first answers 4 questions against the real Bedrock `qwen.qwen3-235b-a22b-2507-v1:0` before any feature code lands.
- AC: (a) does the model emit text preamble deltas before `contentBlockStart(toolUse)` in the same turn? (b) is the toolUse response shape parseable — `contentBlockStart{toolUse} → contentBlockDelta{toolUse.input} → contentBlockStop`, and does the **request** round-trip accept `toolConfig.tools[].toolSpec` + assistant `{toolUse}` + user `{toolResult}` blocks on history resend? (c) round-trip latency (`contentBlockStop → local tool exec → round-2 first text delta`) — is it under the UX budget (<3–5s)? (d) SSE diff between a `toolConfig`-present request that never triggers a tool vs today's request is 100% identical (snapshot/unit test).

### Req 2 — Tier-1 tool registry (internal knowledge only)
WHEN the Tier-1 loop runs, THEN it exposes exactly one tool `search_internal_knowledge(query: string, doc_type?: string)` backed by the existing hybrid search (`knowledge.service.search`, the same one Auto-RAG uses at `inference.routes.ts:687`).
- AC: native Bedrock `toolSpec` shape; zero network beyond the existing pgvector + Cohere embed path; `doc_type` applied as a **post-filter** on returned chunks (no search-signature change, no regression to the Auto-RAG caller); unknown tool names throw (sanitized).
- AC (result bound): the tool returns a **bounded number of top chunks** (`TIER1_TOOL_TOP_K`, default 3), each **in full** — never char-truncated. Chunks are already bounded by ingestion (`splitIntoChunks`), and a chunk's ending often holds its conclusion/recommendation/next-steps, so capping *count* (not cutting *content*) keeps each round's history lean without discarding the valuable tail. The model can re-query with a sharper `doc_type`/query if it needs more.
- AC: the Tier-3 registry (`tool-registry.service.ts` + its `get_current_datetime`) is **untouched** — separate registry/service, no shared internal-access executor.

### Req 3 — Bounded agentic loop inside `generate()`, additive optional param
WHEN the gate is on, THEN `generate()` (optionally extended — see design) runs a Bedrock ConverseStream loop capped at `TIER1_MAX_TOOL_ITERATIONS` (default 3) that intercepts `toolUse`.
- AC (event handling): text `contentBlockDelta` → piped to SSE client **immediately** (live streaming preserved); `contentBlockStart(toolUse)` → stop piping that block, buffer its arg fragments keyed by `contentBlockIndex` until `contentBlockStop`; parse args JSON → execute tool → append assistant `{toolUse}` + user `{toolResult}` → re-invoke ConverseStream.
- AC (stream contract): `event: metadata` (summed across rounds) and `event: done` are sent **once, after the whole loop** — never per round. `event: tool_call` (existing shape `{ tools: [name] }`) is emitted before tool execution so the existing frontend badge renders.
- AC (loop cap): the loop allows **N tool rounds** (`TIER1_MAX_TOOL_ITERATIONS`, default 3) then **one forced final round without tools** — exactly the `external-chat.service.ts` pattern. Runaway is structurally impossible.
- AC (persistence): `assistantText` accumulates **all** streamed text across rounds (preamble + final); only the loop's single result is stored/audited, identical to the single-shot contract. No per-round rows.
- AC (fallback): when the gate/param is absent, `generate()` runs today's exact single-shot code path (zero regression, unit-snapshot protected). If the whole turn yields empty text with a tool round, behave like today's empty handling (sanitized, no empty delta).
- AC (fail-safe, no crash): every tool-round failure (search error, embed error, malformed args, tool timeout) degrades gracefully — the turn still completes with a sanitized outcome, never a thrown error to the client, never a hung connection, never a double `done`/`metadata`, and never an unhandled rejection.

### Req 4 — Gate: model allowlist + JSON text-only + enabled
WHEN deciding whether to offer tools, THEN all of these must hold: (a) `config.routing.tier1Tools.enabled` (default **off**); (b) `resolveModelForInvocation(executedModelId)` equals the allowlisted model (`TIER1_TOOLS_MODEL_ID`, default = routed auto model `qwen.qwen3-235b-a22b-2507-v1:0`); (c) request is the **JSON text path** (no image content blocks); (d) **not** `sovereign-tier-3` external.
- AC: feature ships disabled — no env set → behavior byte-identical to today everywhere. Manual selection of `qwen3-32b` or routing-fallback → no tools (allowlist miss) → byte-identical payload. Multipart/image path → single-shot, untouched. Malformed numeric env values fall back to safe defaults (parse-guarded, never crash).

### Req 5 — PII is safe in Tier-1 (mask at audit only, never in the search path)
WHEN a Tier-1 tool call runs, THEN **no masking is applied to the search path** — the query and the returned chunk text flow as-is, because everything stays inside the private gateway (never leaves for an external provider; the same knowledge text already reaches the model via Auto-RAG's system prompt).
- AC (why): pre-masking the LLM-generated `query` would corrupt the vector search (masked tokens embed poorly, wasted Cohere call, wrong results) for zero privacy gain in a fully-internal path.
- AC (audit): raw PII is kept out of **persistence and logs** only — `tool_calls_meta` (Req 7) stores masked args, never the raw query or unmasked result. Same `pii-masker` discipline as everywhere else in audit.
- AC: the Tier-3 path is untouched — its stricter external-facing rules (`tool-registry.service.ts`, no internal access) are unchanged.

### Req 6 — Auto-RAG preserved; prompt adjusted only for tool turns
WHEN tools are injected, THEN Auto-RAG chunk injection (`buildKnowledgeSection`, route `:755`) still runs as today, and the system prompt's grounding clause (`:759`) is **swapped** for a tool-aware version for that turn only.
- AC: tool-aware wording — "if the Auto-RAG context is insufficient for a complete answer you MUST call `search_internal_knowledge` first; only say 'Informasi ini tidak tersedia' after the tool returned empty/irrelevant". Non-tool turns keep today's grounding verbatim.

### Req 7 — Audit tool-call metadata
WHEN a Tier-1 tool round executes, THEN the existing fire-and-forget audit row records it.
- AC: one new `JSONB` column `audit_logs.tool_calls_meta` (default `'[]'`), filled with `[{ tool, args_masked, duration_ms, result_chunks, result_size }]` per round. Metadata-only — args are masked at write time, the raw query / unmasked result is never stored. Existing audit columns/rows untouched.

### Req 8 — SSE/UX compatibility (frontend: no change)
WHEN the Tier-1 loop emits its new events, THEN existing SSE consumers keep working.
- AC: only additive events `tool_call` (already handled by the Tier-3 badge in `public/index.html`) reach the client mid-loop; `delta`/`metadata`/`done`/`session`/`error` semantics unchanged; no new frontend work required.

### Req 9 — Tests
WHEN the feature is complete, THEN unit tests cover: registry shape + post-filter + unknown-tool throw; search path NOT masked (fully internal); loop interception (text→toolUse→text) with index merge; N tool rounds + 1 plain forced round; summed single `metadata`/`done`; tool-round failure degrades gracefully (no double emit / hang); allowlist-off & non-allowlisted model → payload byte-identical to pre-feature (snapshot); audit `tool_calls_meta` write-time-masked only.
- AC: `npm run build` clean; `npm run test:unit` green; `npm run lint` zero on new/changed files.
