# Requirements — Tier-3 Tools & Thinking (DeepSeek)

## Overview

Extend the existing external Tier-3 path (`external-chat.service.ts` — `global fetch` + manual SSE parse, gated by the `sovereign-tier-3` flag) to expose DeepSeek V4's native **thinking mode** (stream `reasoning_content`) and a **bounded ReAct tool loop** so Tier-3 answers can use real-time local data (start: current datetime).

**Ground truth from empirical spike:**
- Thinking is **default-on** on `v4-flash` — `reasoning_content` is streamed with no `thinking`/`reasoning_effort` body params.
- The "must echo `reasoning_content` back or HTTP 400" rule is **NOT strictly enforced on `v4-flash`** but IS reported in the wild for other models/versions — echo must still be implemented **defensively**.
- Reasoning can consume the output-token budget first (`content=""` early); final content / tool_calls arrive after.

**Hard constraints:** no OpenAI SDK (keep `global fetch`); no Bedrock / `inference.service.ts` changes; tools never touch internal DB/PII/knowledge; API key stays env-only.

---

## Requirements

### Req 1 — Stream thinking to the client
WHEN a Tier-3 request runs on a `deepseek-v4-*` model, THEN the server forwards each `reasoning_content` token as a new `event: reasoning`, streams final text via existing `event: delta`, and finishes with the existing `metadata`/`done` — all without persisting or logging `reasoning_content` (metadata-only audit).
- AC: `reasoning` SSE frames arrive before final content; existing `delta` flow unchanged; audit/DB contain no reasoning text.

### Req 2 — Safe deterministic tool (datetime PoC)
WHEN the model calls `get_current_datetime`, THEN the registry returns the current Asia/Jakarta date-time string, locally, with no network/DB access.
- AC: one tool, zero side effects, fixed schema (`ChatCompletionTool`), unit-testable.

### Req 3 — Bounded ReAct loop with defensive tool detection & strict DB persistence
WHEN the model requests a tool, THEN the server appends the **full assistant message (content + `reasoning_content` verbatim, even `""`, + `tool_calls`)** to the **in-memory history array**, executes the tool, appends the `tool` result, and continues — capped at `MAX_TOOL_ITERATIONS`, after which it forces a final answer without tools.

**Tool Detection Rule:** The loop MUST detect a tool call using the defensive rule: `hasToolCalls = (finish_reason === "tool_calls") OR (accumulated tool_calls.length > 0 at stream end)`. Do not rely solely on `finish_reason` as some providers/chunks may omit it. Merge partial `tool_calls` by `index` per delta.

**DB Persistence Rule:** The server MUST ONLY persist the **final** assistant message (where `finish_reason === 'stop'` and `content` is non-empty) to the database. Intermediate assistant messages that only contain `tool_calls` (with no final `content`) MUST NOT be persisted to the `messages` table. The in-memory history includes `reasoning_content` for the API round-trip, but the DB persistence strictly strips it and only stores the final `content`.
- AC: multi-round stream merges partial `tool_calls` by `index`; loop never exceeds cap; in-memory history echoes reasoning defensively; DB persistence strictly stores ONLY the final non-empty `content` and strips all `reasoning_content`.

### Req 4 — Tools gated per model (no regression for other external models)
WHEN the Tier-3 default model is NOT in the tool allowlist, THEN the request payload is byte-identical to today (no `tools`, no thinking fields) and behaves exactly as before.
- AC: allowlist prefix match via `config.routing.externalTier3.toolModelPrefixes` (default `deepseek-v4-`, env `TIER3_TOOL_MODEL_PREFIXES`); non-listed external model produces the same request body as the pre-feature version (guarded by test). Thinking-capable listed models may opt in to extra body params via `TIER3_THINKING_PARAMS` (e.g. Qwen `{"enable_thinking":true}`).

### Req 5 — Token accumulation, usage fallback, and empty-content guard
WHEN a request spans N tool rounds, THEN input/output tokens from all N calls are summed into ONE `metadata` event and ONE audit row.

**Usage Extraction Rule:** Extract the `usage` object from the final SSE chunk of each iteration (near `[DONE]`/`finish_reason`). IF `usage` is missing from the stream (e.g., non-DeepSeek provider), fallback to estimating tokens via `Math.ceil(content.length / 4)`. Sum across all iterations.

**Empty-Content Guard (B1 Case):** IF `finish_reason === 'stop'` AND `content` is empty (length 0) AND no `tool_calls` were made (meaning reasoning exhausted the token budget), the server MUST NOT emit an empty delta to the client, MUST NOT persist an empty message to the DB, and MUST emit a sanitized error/fallback message (e.g., "Model exhausted reasoning budget without producing an answer").
- AC: summed totals ≥ any single round; reasoning-only frames never truncate the turn early; fallback token estimation works if `usage` is absent; empty-content B1 case is intercepted and sanitized.

### Req 6 — Frontend additive rendering with Screen Reader (a11y) protection
WHEN `reasoning` or `tool_call` events arrive, THEN the chat UI shows a non-blocking "thinking" block (💭, collapsed/italic) and a transient "tool running" badge — and unknown events are ignored without breaking the existing stream parser.

**Screen Reader (a11y) Rule:** The progressive reasoning block (💭) MUST NOT use per-token `aria-live` to prevent screen reader flooding from hundreds of CoT tokens. Instead, use a single `role="status"` region that updates only at the start ('Model is thinking...') and end of the reasoning phase, OR wrap the full reasoning block in a `<details>` element for progressive disclosure (SR reads only when expanded). The transient 'tool running' badge uses `role="status"` once on creation and removal — it does not disrupt the existing tab order.
- AC: normal `delta`/`done` rendering untouched; unknown events ignored gracefully; no layout shift or focus trapping; screen reader is protected from CoT flooding.

### Req 7 — SSE compatibility
WHEN any Tier-3 model streams, THEN existing SSE consumers (session/delta/metadata/done/error) continue to parse correctly.
- AC: no reordering/renaming of existing events; new events additive.

### Req 8 — Tests
WHEN the feature is complete, THEN unit tests cover: mock fetch tool→final sequence; `reasoning_content` echoed on round 2; tool-call index merge; `MAX_TOOL_ITERATIONS` cap; summed token metadata; allowlist-off plain body; no reasoning in audit payload; **DB persistence only saves final non-empty content**; **B1 empty-content guard triggers sanitized error**.
- AC: `npm run build` clean; full unit suite green.

## Deferred
- Exchange-rate tool (needs a provider/key decision).
- `deepseek-v4-pro` verification (thinking opt-in? 400 enforcement?) before relying on it.
- Tool enablement per model stored in DB (`tier3_models`) instead of a code allowlist.
