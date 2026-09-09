# Design — Tier-1 Internal Tool Loop (Multi-Hop RAG)

Traceability → `docs/features/tier1-tools/requirements.md` [Req N].

## Architecture

Single seam extended: **`generate()` in `inference.service.ts`** gains an **optional** tool-loop mode. Absent → today's code path runs (zero regression). Present → a bounded ConverseStream ReAct loop, additive over the existing Auto-RAG system prompt. Routing, storage, audit, frontend, Tier-3 `external-chat.service.ts`: **unchanged**.

```
inference.routes (:779 dispatch)
  │ isTier3External?  ────────────────► external-chat (unchanged, Tier-3)
  ▼ (private Bedrock)
  toolsEnabled = cfg.routing.tier1Tools.enabled
              && resolveModelForInvocation(executedModelId) === cfg.routing.tier1Tools.modelId
              && JSON-text path (no image blocks)
  └─ tools enabled?  ─► generate(req, res, { tools: BEDROCK_TOOLS, exec, maxIterations })
  └─ else            ─► generate(req, res)                     // byte-identical today
```

**generate() loop (only when 3rd arg present):**
```
for round in 0..maxIterations:                      // N tool-capable + 1 plain forced
  hasTools = round < maxIterations                  // last round: toolConfig stripped
  stream = ConverseStream({..., toolConfig:{tools}} when hasTools)
  sawToolUse = false ; accumulated per-blockIndex buffers/text
  for event in stream:
    contentBlockStart:  record type[blockIndex] (text | toolUse + id + name)
    contentBlockDelta:  blockIndex is text → write SSE delta (+accumulate)
                        blockIndex is toolUse → buffer arg fragment under index
    metadata:           accumulate usage (suppressed from client)
    messageStop:        break (capture stopReason)
  sawToolUse = stopReason==='tool_use' || toolUses.length>0
  if sawToolUse && hasTools:                        // tool round, cap not yet hit
     emit SSE event: tool_call { tools:[names] }
     per toolUse:  exec(args) → push {role:user, content:[{toolResult}]}
     continue
  else:                                             // plain round or cap reached
     emit SSE event: metadata (SUMMED usage) ; event: done ; return result
```

**Key rules**
- Client sees, mid-loop, **only** text deltas + one `tool_call` badge per round. `metadata`/`done` once at the very end (Req 3).
- `assistantText` returned = all text deltas across all rounds (preamble + final) — matches exactly what the client saw, so resume history is consistent (Req 3).
- Event dispatch is per-`contentBlockIndex` (text and toolUse can interleave in one turn) — not a linear state machine.

## Components & Interfaces

### `inference.service.ts` — extend `generate()` (optional param)

```ts
// additive; existing 2-arg callers (routes :795/:1445/:1461) untouched
generate(
  request: InferenceRequest | ConversationInferenceRequest,
  res: Response,
  toolLoop?: {
    tools: BedrockToolSpec[];                 // native toolConfig shape
    execTool: (name: string, args: unknown) => Promise<string>;  // masked args in/out
    maxIterations: number;                    // cfg default 3
  },
): Promise<InferenceResult | ConversationInferenceResult>
```

When `toolLoop` is absent the function body is today's exact single-shot path. When present, the `toolConfig` field is added to the command **except on the forced final round** (cap). Bedrock native shapes (types from `@aws-sdk/client-bedrock-runtime`):

```ts
type BedrockToolSpec = { toolSpec: {
  name: string; description: string;
  inputSchema: { json: Record<string, unknown> };
} };
// assistant content block: { toolUse: { toolUseId, name, input } }
// tool-result content block (user): { toolResult: { toolUseId, content:[{text}], status:'success' } }
```

### `src/services/tier1-tools.service.ts` (new)

```ts
export const TIER1_TOOLS: BedrockToolSpec[];   // [Req 2] search_internal_knowledge(query, doc_type?)
export async function execTier1Tool(name, args): Promise<string>;
// → NO PII masking on the search path [Req 5] — query + result flow as-is
//   (fully internal; masking would corrupt the vector search for zero gain)
// → search via knowledge.service `search` (same hybrid fn as route :687),
//   doc_type applied as post-filter on chunk.docType
// → returns the top `tier1Tools.toolTopK` chunks (default 3) IN FULL — count-capped,
//   never char-truncated, so each chunk's tail (conclusion/next-steps) is preserved;
//   empty → "Tidak ada hasil relevan."
// unknown tool → throw (caller sanitizes); never throws raw DB/embed errors upward
```

`tool-registry.service.ts` (Tier-3 public `get_current_datetime`) is **not** imported here — separate files, separate invariants.

### Config (`src/config/index.ts`, `routing.tier1Tools`)

```ts
tier1Tools: {
  enabled: process.env.TIER1_TOOLS_ENABLED === 'true',      // default OFF → zero behavior change
  modelId: process.env.TIER1_TOOLS_MODEL_ID || routing.autoModelId,  // qwen.qwen3-235b-…
  maxIterations: parseBoundedInt('TIER1_MAX_TOOL_ITERATIONS', 3, 1, 10),   // parse-guarded
  toolTimeoutMs: parseBoundedInt('TIER1_TOOL_TIMEOUT_MS', 30000, 1000, 120000), // never crash
  toolTopK: parseBoundedInt('TIER1_TOOL_TOP_K', 3, 1, 10),  // result count cap (see execTier1Tool)
}
// numeric envs reuse the config module's existing parse-guard idiom (clamp to sane bounds,
// never NaN/throw); malformed values fall back to defaults
```

### Route gate (`inference.routes.ts` :779)

```ts
const tier1ToolsOn = !isTier3External
  && config.routing.tier1Tools.enabled
  && tier3ModelId === config.routing.tier1Tools.modelId     // allowlist (private qwen3-235b)
  && /* JSON-text path: no image content blocks in this request */;
const result = isTier3External ? /* unchanged external */
  : await generate(conversationRequest, res,
      tier1ToolsOn ? { tools: TIER1_TOOLS, execTool: execTier1Tool,
                       maxIterations: config.routing.tier1Tools.maxIterations } : undefined);
```

System prompt (`:754-759`): when `tier1ToolsOn`, swap the grounding clause for the tool-aware variant (Req 6). Auto-RAG `buildKnowledgeSection` injection unchanged.

### SSE events (additive, reuse)

| Event | When | Content |
|---|---|---|
| `tool_call` (exists) | once per tool round, before exec | `{ tools: ["search_internal_knowledge"] }` → existing frontend badge |
| `delta` | per text delta, live | unchanged |
| `metadata` | once, loop end | **summed** input/output tokens |
| `done` | once, loop end | `{}` |

No frontend change (Req 8).

## Data Models

New migration for `tool_calls_meta` [Req 7]. **Filename number is resolved at implementation time** — pick the next free number above the highest migration file present (034 today; `030_*` is an in-flight untracked sibling). Runner is idempotent (`_migrations` tracking), so a renumber is harmless.

```sql
ALTER TABLE audit_logs ADD COLUMN tool_calls_meta JSONB DEFAULT '[]';
```

`AuditEntry` (`src/types/audit.types.ts`) + `audit.service.ts` INSERT gain one optional `tool_calls_meta` field. Existing columns untouched.

## Error Handling [Req 3, 4, 5]

| Failure | Detection | Behavior |
|---|---|---|
| Tool requested at cap | `round === maxIterations` (plain round) | Plain forced final round without `toolConfig` → normal single-shot result; **never an error** |
| Args JSON unparseable | JSON.parse throws | Treated as tool-round failure → graceful fallthrough, not a thrown client error; loop continues/ends sanely, single `done` |
| Search/embed error mid-tool | `execTier1Tool` error | Sanitized fallback text to the model (e.g. "Pencarian gagal"); inference completes; no crash, no raw error leak |
| Unknown tool name | `execTier1Tool` throw | Sanitized fallback; never leaks internals/keys |
| Whole turn empty text | like today's empty handling | Sanitized error; no empty delta |
| Non-2xx/upstream | existing | existing sanitized path |
| Client disconnect mid-loop | res.write throws | abort loop; existing cleanup |
| Tool exec exceeds timeout | elapsed > `toolTimeoutMs` | abort tool round → graceful fallthrough; connection never hangs |

No-crash invariant: any tool-round failure resolves into a completed SSE turn (single `metadata`/`done`) or the existing sanitized `error` path — **never** a throw that leaves the SSE stream open, a double `done`, or an unhandled rejection. Raw args/`reasoning_content` never logged; audit stores masked args + sizes only.

## Verification

1. Spike (Req 1) green before Wave 2.
2. `npm run build`; `npm run test:unit`; `npm run lint` zero on new/changed.
3. Zero-regression snapshot: `generate(req,res)` 2-arg output equals pre-feature.
