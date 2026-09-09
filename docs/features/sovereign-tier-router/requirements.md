# Sovereign Tier Router + OpenAI-Compatible Tier 3 (Phase 2)

## Overview

Tiers are **infrastructure layers of the private stack**, not three ranked LLMs:

- **T1 — Bedrock private generation.** The current AWS Bedrock models (execution environment is
  private; restricted data stays here). Auto default `qwen3-235b`, overridable via env.
- **T2 — Cohere knowledge (existing).** Cohere Embed v4 retrieval against internal knowledge docs.
  Every text turn already runs `knowledgeSearch` and injects retrieved chunks into the private
  Bedrock prompt. All internal — nothing leaves.
- **T3 — external model (NEW).** An OpenAI-compatible gateway (`/chat/completions`) for
  non-restricted, text-only requests that need **no internal knowledge** — e.g.
  `qwen3.7-flash-2026-07-15`, `MiniMax-M2.7-highspeed`. Admin-curated model list. Auto-only.

Auto mode classifies the **data** the request carries (sovereignty gate, not a user manual pick).
A restricted request is hard-blocked from T3. A request whose answer needs internal knowledge is
also blocked from T3 (retrieved internal text must never reach an external provider).

Everything deterministic — zero LLM routing calls. Behavior stays byte-identical to Tahap 1 until
the operator opts in (env + dashboard config).

## Glossary

| Term | Meaning |
|---|---|
| Restricted | `maskResult.entityCount > 0` (PII) **or** a hit on the admin-managed restricted-word list (case-insensitive substring on masked prompt/doc text). False-positive-biased: any hit → private. |
| Private stack | T1 + T2 together: Bedrock generation grounded by Cohere internal knowledge. Data never leaves AWS. |
| Restricted words | Admin-CRUD table (`restricted_terms`). Term match keeps a request private even when PII masking found nothing. |
| `classifySovereignTier()` | Deterministic classifier at the top of `selectAutoModel`. Outputs `restricted` boolean. T3 is a caller escalation, never classifier output. |
| Tier-3 gateway | Single OpenAI-compatible `baseUrl/chat/completions`. `TIER3_BASE_URL` + `TIER3_API_KEY` in env (key never in DB/API). |
| Tier-3 models | Admin-managed rows (`tier3_models`): `model_id`, one default, enabled. Auto escalation uses the default. |

## Requirements

### Req 1 — Deterministic sovereignty gate (Auto)
- WHEN `routingState === 'auto'` THEN a deterministic classifier runs over the masked prompt
  (+ masked doc text when present). PII detected or restricted-word hit → **restricted**.
- WHEN restricted THEN the decision is never T3 regardless of gateway config — the request executes
  on the private stack only.
- Reason/flags reuse the Tahap-1 seam (`routingReasonCode` + `flags`), no schema change:
  restricted → `auto-tier-1` + `sovereign-tier-1`; external escalation → `auto-tier-3` +
  `sovereign-tier-3`. Non-restricted private stays the Tahap-1 `auto-fixed-model` (byte-identical).

### Req 2 — T1 private model, configurable
- Restricted requests run on Bedrock: model = `TIER1_MODEL_ID` env, empty → `routing.autoModelId`
  (qwen3-235b default). Zero change with no env set.
- Chosen model inaccessible → silent `DEFAULT_MODEL` + `auto-access-denied` (unchanged), no 403.
  Tier flag preserved on that fallback.
- T1 keeps using T2 knowledge normally (both internal).

### Req 3 — T2 Cohere knowledge blocks T3
- T2 is the existing knowledge retrieval — no new model knob. It rides on every private turn.
- WHEN a request would be answered from internal knowledge (retrieval returns chunks) THEN it must
  stay on the private stack. **T3 never receives internal knowledge text.**
- Consequence: T3 applies only to requests whose retrieval returns **no** chunks (pure general
  questions) — decided after retrieval, before any stream starts.

### Req 4 — Tier-3 gateway (env) + models (admin), auto-only
**Story:** operator sets one OpenAI-compatible gateway and curates models without redeploy.

- `config.externalTier3`: `{ baseUrl: TIER3_BASE_URL, apiKey: TIER3_API_KEY, enabled: TIER3_ENABLED==='true' }`.
- DB `tier3_models` (`model_id` pk, `is_default`, `enabled`) managed by admin. No per-user access
  list — the gateway key is the gate (T3 skips `checkModelAccess`).
- WHEN gateway enabled AND request open (non-restricted) AND text-only (`!hasImages &&
  !documentText`) AND retrieval is empty AND an enabled default model exists → decision =
  external default model, reason `auto-tier-3`, flag `sovereign-tier-3`.
- WHEN disabled, or no default model, or retrieval non-empty, or restricted → private stack, never
  error.
- T3 models are **not** added to the manual user model dropdown (auto-only). Manual/passthrough
  untouched.

### Req 5 — Restricted-word administration
**Story:** an admin curates the restricted lexicon without redeploy — add and delete terms live.

- Table `restricted_terms` (`term` pk). Admin CRUD: list, add, delete (`GET/POST/DELETE
  /api/v1/admin/restricted-terms`).
- Matching: case-insensitive substring of the masked prompt (+ masked doc text). Term stored as
  written; matching lowercases both sides.
- Classifier reads terms through a small cache (TTL) so admin edits propagate without a redeploy
  and without a DB hit per request in the hot path.

### Req 6 — External inference path (OpenAI-compatible streaming)
- WHEN decision is T3 THEN the handler streams against `baseUrl/chat/completions` with
  `{ model, messages, stream: true, stream_options: { include_usage: true } }` and a Bearer key —
  not Bedrock. Same masked prompt + system role ('fallback') assembly as the private text path
  (knowledge section absent by construction).
- SSE contract identical to Bedrock: `delta` per token, `metadata{inputTokens,outputTokens}` (usage
  chunk; chars/4 estimate when absent), `done`, sanitized `error` (no key/base URL leak). Client UI
  and audit code unchanged.
- Audit records the external model id and its input/output tokens. Model ids listed in
  `src/frontend/pricing-config.json` (see Req 7) so cost reports stay correct.

### Req 7 — Pricing entries + tests & observability
- Add entries to `src/frontend/pricing-config.json` under `models[<external id>]` for the external
  models seeded in `tier3_models` (display name + per-1M-token prices), so cost display/audit
  resolve them like Bedrock models.
- Classifier: restricted-by-PII, restricted-by-word (case-insensitive), open default.
- `selectAutoModel`: no env → byte-identical to Tahap 1; gateway off → never T3; gateway on +
  default → candidate; restricted + gateway on → `auto-tier-1` (never candidate).
- Handler gate: candidate + empty retrieval → `auto-tier-3` external; candidate + chunks → private.
- External client: parses SSE, forwards deltas, captures usage, sanitizes HTTP/network errors to a
  sanitized SSE `error`.
- `routing` SSE + audit carry the tier via reason/flags; no new columns.

## Non-goals (this phase)
- `/admin/tier3/test` endpoint — **skipped** (manual curl validates key+model).
- No multi-gateway, no per-model credentials, no manual-user exposure of T3 models, no T3 on
  images/documents (text-only), no retry/backoff on the external path, no Bedrock fallback
  mid-stream after the external path starts emitting.
