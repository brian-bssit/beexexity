# Design — Sovereign Tier Router + OpenAI-Compatible Tier 3

## Architecture

```
routeRequest(auto)
  → selectAutoModel(ctx)                       // deterministic, zero LLM
       ctx = { userId, hasImages, prompt: maskedPrompt, piiDetected, documentText? }
       1. restricted = classifySovereignTier(prompt, piiDetected, documentText)
            piiDetected | restricted-word hit → restricted (private)
       2. restricted
            → model = TIER1_MODEL_ID || autoModelId (Bedrock)
            → reason 'auto-tier-1', flags ['sovereign-tier-1']   // never T3
       3. open (non-restricted)
            → model = autoModelId, reason 'auto-fixed-model' (byte-identical to Tahap 1)
            → IF gateway enabled && !hasImages && !documentText && default T3 model exists
                 → flags push 'tier3-candidate'   // provisional; final model decided post-retrieval
       4. access: open/restricted keep checkModelAccess fallback (auto-access-denied, candidate
            dropped); no T3 reachable here yet
  → routingDecision { executedModelId, routingReasonCode, flags }

JSON text handler (post-retrieval finalize — T3 gate lives HERE, not in routing):
  knowledgeChunks = knowledgeSearch(effectivePrompt, topK)   // Cohere Embed v4 (T2), always runs
  if decision.flags includes 'tier3-candidate'
      → knowledgeChunks.length === 0
          → executedModelId = tier3 default model
          → reason 'auto-tier-3', flags ['sovereign-tier-3']   // EXTERNAL
        else
          → drop candidate → stay private Bedrock (knowledge grounds the answer)  // T1+T2
  → emit routing SSE (deferred until now ONLY for candidates) → build system/conversationRequest
  → flags has 'sovereign-tier-3'
      → streamExternalCompletion(model=executedModelId, messages, res)   // NOT Bedrock
      → delta / metadata(inputTokens,outputTokens) / done / sanitized error
  else → generate() Bedrock (unchanged)
```

Why the gate is post-retrieval: `knowledgeSearch` runs at `inference.routes.ts` text handler after
`routeRequest` (line ~676) and injects internal chunks into the prompt. Whether T2 content attaches
is only known there — so the restricted **word/PII** half of the gate lives in routing (no DB/LLM,
fast), while the **knowledge-empty** half of the T3 gate lives right after retrieval, before any
stream byte is sent. Routing SSE for a candidate is deferred so the client/audit see the final tier.

`tier3-candidate` is provisional: Bedrock `auto-fixed-model` + candidate flag. Non-candidate
requests keep the routing SSE exactly where it is today → byte-identical when the gateway is off.

## Components & Interfaces

### `classifySovereignTier(input): boolean` — pure except terms read (routing-engine.service.ts)
```ts
interface SovereignTierInput { prompt: string; piiDetected?: boolean; documentText?: string }
// true = restricted (private only). Terms via restricted-terms cache.
```
1. `piiDetected === true` → true
2. `hay = (prompt + ' ' + (documentText ?? '')).toLowerCase()`;
   `(await getRestrictedTerms()).some(t => hay.includes(t.toLowerCase()))` → true
3. else false.
Never consults T3; T3 is caller escalation only → restricted can't reach it.

### `selectAutoModel(ctx)` — extended (AutoModelContext grows; AutoModelSelection stable)
```ts
interface AutoModelContext {
  userId: string; hasImages: boolean; prompt: string;   // prompt = masked originalPrompt
  piiDetected?: boolean; documentText?: string;         // documentText from maskedDocumentText
}
interface AutoModelSelection { modelId; reasonCode; flags }   // unchanged shape
```
Built from `RoutingInput` inside `routeRequest` (line ~144) → add `piiDetected` to `RoutingInput`.

### Config — `src/config/index.ts` (routing block append)
| Env | Default | Meaning |
|---|---|---|
| `TIER1_MODEL_ID` | `''` → autoModelId | Restricted private Bedrock model (Req 2). No T2 knob — T2 is the existing Cohere path. |
| `TIER3_BASE_URL` | `''` | OpenAI-compatible base, e.g. `https://gateway.example/v1` |
| `TIER3_API_KEY` | `''` | Gateway key (env only, never in DB/API) |
| `TIER3_ENABLED` | `'false'` | Kill switch |

No env ⇒ gateway off ⇒ every request follows Tahap-1 exactly.

### DB — migrations
`032_tier3_models.sql`
```sql
CREATE TABLE IF NOT EXISTS tier3_models (
  model_id   text PRIMARY KEY,          -- e.g. qwen3.7-flash-2026-07-15
  is_default boolean NOT NULL DEFAULT false,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tier3_models (model_id, is_default) VALUES
  ('qwen3.7-flash-2026-07-15', true),
  ('MiniMax-M2.7-highspeed', false)
ON CONFLICT (model_id) DO NOTHING;        -- seed examples; admin edits freely
```
One default enforced in service (uniqueness in code, not a partial index).

`033_restricted_terms.sql`
```sql
CREATE TABLE IF NOT EXISTS restricted_terms (
  term       text PRIMARY KEY,           -- stored as written; matched lowercased
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Baseline examples (documentation-by-example; admin deletes/adds freely):
INSERT INTO restricted_terms (term) VALUES
  ('rahasia'), ('confidential'), ('internal'), ('classified'), ('rahasia bank'), ('data pribadi')
ON CONFLICT (term) DO NOTHING;
```

### Services
`src/services/tier3.service.ts` (new)
- `listModels(): Promise<{ modelId, isDefault, enabled }[]>`
- `setModels(models: {modelId, enabled}[], defaultId): Promise<void>` — txn: upsert list, delete
  missing, clear `is_default`, set one (none valid → all false).
- `getDefaultTier3Model(): Promise<string | null>` — enabled default; fallback first enabled.
  TTL-cached (~30s) to keep the routing path DB-light when the gateway is on.
- `isEnabled()` → `config.externalTier3.enabled && !!(baseUrl && apiKey)`.

`src/services/restricted-terms.service.ts` (new)
- `getRestrictedTerms(): Promise<string[]>` — cache (TTL ~60s); invalidate on admin write.
- Admin: `list()`, `addTerm(term)` (trim, lowercase store optional → store as-is, match lowercased;
  length guard 1..128; dup → conflict error), `deleteTerm(term)`.

`src/services/external-chat.service.ts` (new)
- `streamExternalCompletion(opts): Promise<{ inputTokens, outputTokens }>` via global `fetch`:
  - POST `${baseUrl}/chat/completions` `{ model, messages, stream: true, stream_options:
    { include_usage: true } }`, `Authorization: Bearer ${apiKey}`.
  - Parse SSE `data:` lines → forward `choices[0].delta.content` deltas to the handler's SSE writer
    (same `delta` shape as Bedrock); capture final `usage` (`prompt_tokens`, `completion_tokens`).
  - Missing usage → `ceil(chars/4)` estimate (Bedrock fallback convention).
  - Non-2xx → sanitized `InferenceError` (no key/base URL leak); network → `model_error`; surfaced
    as an SSE `error` event. Single attempt (no retry) in Phase 2.
- Messages map: system prompt → `{role:'system'}`, history/current user masked text →
  `{role:'user'}`. Text-only.

### Handler changes — `src/routes/inference.routes.ts` (JSON text path)
- PII threading (~443): `piiDetected = maskResult.entityCount > 0` → `routingInput.piiDetected`.
- Multipart (~986): same `piiDetected` add. Doc text already flows in as `maskedDocumentText`
  (routingInput build, ~1116) — classifier reads it via `AutoModelContext.documentText`. No T3
  anyway (docs force Bedrock); classifier labels restricted for audit consistency.
- After `knowledgeSearch` (~677): finalize candidate (above). Deferred routing SSE emitted only for
  a candidate (skip the ~638 emit when `flags` has `tier3-candidate`, emit after finalize with the
  mutated decision). Non-candidate → SSE untouched at ~638.
- Dispatch (~741): `flags.includes('sovereign-tier-3')` → `streamExternalCompletion(...)` and use
  its `{inputTokens, outputTokens}` as the result (same downstream store/audit shape) else
  `generate()`. Audit unchanged — `resolveModelForInvocation` is identity (`return modelId`), so
  `modelId = executedModelId` already records the raw external id.

### Admin routes + UI
- `GET  /api/v1/admin/tier3` → `{ enabled, baseUrlHost, apiKeySet, models:[{modelId,isDefault,
  enabled}], defaultModel }`. Reads env; key never returned.
- `PUT  /api/v1/admin/tier3` → `{ models:[{modelId, enabled}], defaultModel }` → `setModels`.
- `GET    /api/v1/admin/restricted-terms` → `{ terms: string[] }`
- `POST   /api/v1/admin/restricted-terms` body `{ term }` → add (dup → 409)
- `DELETE /api/v1/admin/restricted-terms/:term` → delete (not-found → 404)
- Admin UI (Config tab): two blocks —
  - **Tier 3 — External Gateway**: read-only env status (enabled, host, key ✓/—), editable model
    rows (add/remove/enable), default radio, Save. No key input, no Test button.
  - **Restricted words**: term chips/list with per-row Delete + inline add input. Immediate
    add/delete (no Save batching). Reuse modal/toast/badge patterns.

### Pricing — `src/frontend/pricing-config.json`
Add under `models[<external id>]` for the seeded/known external model ids
(`qwen3.7-flash-2026-07-15`, `MiniMax-M2.7-highspeed`) — `displayName`, `inputPricePer1MTokens`,
`outputPricePer1MTokens` (from the gateway's published prices). Reuses the existing models.routes
load path → cost display + audit cost resolution work unchanged.

## Data flow (T3 request)
```
auto, text-only, open (no PII, no restricted word), TIER3_ENABLED=true, default T3 model set
  → selectAutoModel → Bedrock model + flags ['tier3-candidate']   (routing SSE deferred)
  → knowledgeSearch → chunks empty
  → finalize → executedModelId = qwen3.7-flash-2026-07-15, reason 'auto-tier-3'
  → routing SSE { model, reason, flags ['sovereign-tier-3'] }
  → external-chat.streamExternalCompletion → delta… → metadata{tokens} → done
  → audit: modelId = qwen3.7-flash-2026-07-15, input/output tokens (audit cost from pricing-config)
```

## Error Handling

| Scenario | Behavior |
|---|---|
| TIER3 enabled but empty base_url/api_key | `isEnabled()` false → no candidate → private Bedrock. |
| Enabled, no default model in DB | `getDefaultTier3Model()` null → no candidate → private. |
| Candidate, knowledge non-empty | Candidate dropped → private Bedrock, knowledge grounds answer (T3 never sees internal text). |
| Candidate, restricted sneaks in | Classifier returned restricted in routing → no candidate flag → unreachable. |
| External call fails (HTTP/network/stream) | Sanitized SSE `error`; handler audit 0 tokens; no Bedrock fallback mid-stream. |
| `checkModelAccess` throws (open/restricted) | Fail-closed false → DEFAULT_MODEL + `auto-access-denied`; candidate dropped (user lacks Bedrock access → no T3 either). Conservative. |
| Restricted terms cache empty/DB down | Classifier degrades to PII-only (`[]` terms) — never blocks inference. |
| Knowledge retrieval failure | Unchanged — self-timeout, `[]`, candidate escalates (no internal text found ⇒ safe). |
| No env + empty DBs | Tahap-1 behavior byte-identical. |

## Non-goals (this phase)
- No `/admin/tier3/test` (skipped), no multi-gateway, no per-model creds, no manual-user exposure
  of T3 models, no images/documents through T3, no retry/backoff on external yet.
