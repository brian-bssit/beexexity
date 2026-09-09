# Design — Tier-3 Tools & Thinking (DeepSeek)

Traceability → `docs/features/tier3-tools/requirements.md` [Req N].

## Architecture

Single seam extended: `src/services/external-chat.service.ts`. Dispatch, audit, storage, routing **unchanged** — the service already writes SSE itself and returns one `ConversationInferenceResult` that the handler stores/audits as a success. No new provider service, no SDK, no DB schema change, no Bedrock touch.

```
inference.routes (flag sovereign-tier-3)
  └─ streamExternalCompletion(req, baseUrl, apiKey, writer)
       loop ≤ MAX_TOOL_ITERATIONS:
         build body  (tools ONLY if model in allowlist)
         fetch /chat/completions (SSE)
         parse chunks:
           delta.content            → event: delta
           delta.reasoning_content  → event: reasoning      (NEW)
           delta.tool_calls         → merge by index
           usage (final chunk)      → accumulate tokens
         end-of-turn decision:
           hasToolCalls = (finish_reason==="tool_calls") OR (tool_calls.length>0)
             yes → push assistant (content+reasoning_cont+tool_calls) → execute tools
                   → push tool result → next iteration
             no  → final: content non-empty? return result  : B1 guard error
       emit event: metadata (SUMMED) + event: done
  └─ handler stores result.assistantText (final content ONLY) + audits summed tokens
```

**Thinking is default-on** for `deepseek-v4-*`: no `thinking`/`reasoning_effort` body field is sent (proven no-op on flash). `reasoning_content` is streamed regardless.

**DB persistence is inherently safe:** only the returned `assistantText` is stored. Tool-call assistant frames and `reasoning_content` never leave this service.

## Components & Interfaces

### `external-chat.service.ts` (extend)

```ts
// NEW — additive, internal to this service (OpenAI wire format). Not exported widely.
interface OpenAIWireMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoning_content?: string;      // assistant, echoed verbatim when present (defensive)
  tool_calls?: Array<{             // assistant, merged by index from stream
    id: string; type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;           // tool-result messages
}

// allowlist gate lives in config: config.routing.externalTier3.toolModelPrefixes
// (env TIER3_TOOL_MODEL_PREFIXES, default 'deepseek-v4-'). Optional per-model thinking
// body params: config.routing.externalTier3.thinkingParams (env TIER3_THINKING_PARAMS).
const MAX_TOOL_ITERATIONS = 3;              // [Req 3] loop cap

// NEW signature (extend existing export; writer/result contract unchanged):
streamExternalCompletion(
  request: ConversationInferenceRequest,   // unchanged shape
  baseUrl: string, apiKey: string,
  writer: SSEWriter,
  tools?: ToolDefinition[],                 // NEW optional — present iff allowlisted
): Promise<ConversationInferenceResult>     // unchanged; assistantText = final content only
```

Working history = `messages: OpenAIWireMsg[]` rebuilt from `request.system` + `request.messages` (as today), then appended to across iterations.

Helpers (all local to the service):
- `mergeToolCalls(acc: OpenAIWireMsg['tool_calls'], deltaToolCalls)` — merge by `index`; keep `id`/`name` from first fragment, concatenate partial `arguments` per index. [Req 3]
- `estimateCharsTokens(msgs: OpenAIWireMsg[])` → `ceil(totalChars / 4)` per iteration when `usage` absent. [Req 5]
- `runTool(name, args) → Promise<string>` — dispatch to `executeTool` (registry). [Req 2]

### `tool-registry.service.ts` (new, minimal)

```ts
export interface ToolDefinition {           // OpenAI ChatCompletionTool shape
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean };
}
export const AVAILABLE_TOOLS: ToolDefinition[];  // [Req 2] get_current_datetime
export function executeTool(name: string, args: unknown): Promise<string>;  // throws on unknown tool
```

Datetime tool: zero network/DB, returns `Asia/Jakarta` formatted string.

### SSE events (additive) [Req 1, 7]

| Event | Payload | When |
|---|---|---|
| `reasoning` (NEW) | `{ content: "<token>" }` | per `reasoning_content` delta |
| `tool_call` (NEW) | `{ tools: ["get_current_datetime"] }` | once per round, after tool_calls detected |
| `delta` | existing | unchanged |
| `metadata` | existing — token totals **summed across iterations** | once, after loop |
| `done` | existing | unchanged |

### Route call-site (`inference.routes.ts` ~778)

```ts
const modelId = resolveModelForInvocation(executedModelId);      // unchanged
const capable = cfg.externalTier3.toolModelPrefixes.some((p) => p && modelId.startsWith(p));  // [Req 4]
const tools = capable ? AVAILABLE_TOOLS : undefined;
const thinking = capable ? cfg.externalTier3.thinkingParams : undefined;
const result = await streamExternalCompletion(req, cfg.baseUrl, cfg.apiKey, writer, tools, thinking);
// storage/audit below is UNCHANGED — stores result.assistantText (final content), audits result tokens.
```

B1 case throws `InferenceError` before returning → existing error path emits sanitized `error`, no DB row, no success audit. [Req 5]

### Frontend (`public/index.html`) [Req 6]

- Per assistant turn: `reasoning` frames append text to a `💭` block (`<div class="reasoning">`, italic/secondary). Screen-reader: a `role="status"` region labelled "Model is thinking…" is set on first `reasoning` frame and cleared on first `delta` or `done` — **no per-token live region**. Alternative (preferred if kept visible): wrap the block in `<details>` so SR reads on demand.
- `tool_call` event → transient badge `🔍 <tool>` with `role="status"`, removed on next `delta`/`done`.
- Unknown SSE events ignored (existing tolerant parser). No layout shift: block reserved only while reasoning frames are arriving.

## Data Models

None. No migration. Tool enablement stays a code allowlist (`deepseek-v4-`) per [Req 4]; DB-backed per-model capability is deferred. `reasoning_content` never touches `messages`, `audit_logs`, or the session memory pipeline.

## Error Handling [Req 3, 5]

| Failure | Detection | Behavior |
|---|---|---|
| Tool requested beyond cap | `iterations >= MAX_TOOL_ITERATIONS` with pending tool_calls | Force one final answer **without** tools (strip tools on last body); then normal result |
| B1 — `stop`, content empty, no tool_calls | end-of-stream check | Throw `InferenceError('…exhausted reasoning budget…', 'model_error', 502)`; no empty `delta`, no DB row |
| Unknown tool name | `executeTool` throws | Sanitized `InferenceError` → error SSE; no key/URL leaked |
| Tool exec throws (network of future tools) | `runTool` catch | Same sanitized path |
| Non-2xx / upstream 400 | existing | Existing sanitized `Tier-3 model … failed (code)` (now includes DeepSeek 400 wording verbatim) |
| Stream interrupted mid-iteration | reader throw | Existing sanitized `model_error` |
| `usage` absent (non-DeepSeek) | per-iteration | `estimateCharsTokens` fallback; totals still summed [Req 5] |

Audit/pricing: `usage.completion_tokens` already includes reasoning tokens; summed totals feed the single existing audit row — no pricing change.
