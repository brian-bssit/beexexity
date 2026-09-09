# Tasks — Sovereign Tier Router + OpenAI-Compatible Tier 3 (Phase 2)

Traceability → Req. Small tasks — 7-Step Ladder.

## Wave 1 — Config, migrations, services [Req 2, 4, 5]

- [x] 1. `src/config/index.ts` (routing block): add `tier1ModelId` (`TIER1_MODEL_ID`, `''` →
      autoModelId) + `externalTier3: { baseUrl: TIER3_BASE_URL, apiKey: TIER3_API_KEY,
      enabled: TIER3_ENABLED==='true' }`. [Req 2, 4]
- [x] 2. `migrations/032_tier3_models.sql` — table + seed per design. [Req 4]
- [x] 3. `migrations/033_restricted_terms.sql` — table + baseline seed per design. [Req 5]
- [x] 4. `src/services/tier3.service.ts` — `listModels` / `setModels` (txn upsert + delete-missing +
      single default) / `getDefaultTier3Model` (TTL cache) / `isEnabled`. [Req 4]
- [x] 5. `src/services/restricted-terms.service.ts` — `getRestrictedTerms` (TTL cache) +
      `addTerm`/`deleteTerm`/`list`; invalidate cache on write. [Req 5]

## Wave 2 — Classifier + selectAutoModel [Req 1, 2, 4]

- [x] 6. `src/types/routing.types.ts`: add `piiDetected?: boolean` to `RoutingInput`. [Req 1]
- [x] 7. `routing-engine.service.ts`: extend `AutoModelContext` (`prompt`, `piiDetected`,
      `documentText`); export pure `classifySovereignTier` (PII → restricted; terms hit →
      restricted; else open). [Req 1, 5]
- [x] 8. `routeRequest` (~144): build `AutoModelContext` from the extended `RoutingInput`. [Req 1]
- [x] 9. `selectAutoModel`: restricted → `tier1ModelId||autoModelId`, reason `auto-tier-1`, flag
      `sovereign-tier-1`; open → unchanged `auto-fixed-model`, and if gateway enabled + text-only
      + default T3 model exists → push `tier3-candidate`. Access-denied → `auto-access-denied`,
      candidate dropped. Update header comment. [Req 1, 2, 4]
- [x] 10. `npm run build` clean. [checkpoint]

## Wave 3 — External client [Req 6]

- [x] 11. `src/services/external-chat.service.ts`: `streamExternalCompletion({baseUrl, apiKey,
      model, messages, signal, onDelta})` → fetch SSE, forward deltas, capture usage, chars/4
      fallback, sanitized errors (no key/URL). [Req 6]
- [x] 12. Reuse role 'fallback' system-prompt + text assembly (same shape as the private text path;
      knowledge section absent by construction). [Req 6]

## Wave 4 — Handler: PII threading, finalize, dispatch [Req 1, 3, 6]

- [x] 13. JSON handler (~443): `piiDetected = maskResult.entityCount > 0` → `routingInput`.
      Multipart (~986): same `piiDetected` add (doc text already sent as `maskedDocumentText`).
      [Req 1]
- [x] 14. Defer routing SSE (~638) only when `flags` has `tier3-candidate`. [Req 3, 4]
- [x] 15. After `knowledgeSearch` (~677): finalize candidate — chunks empty → executedModelId =
      tier3 default, reason `auto-tier-3`, flags `['sovereign-tier-3']`; else drop candidate.
      Emit deferred routing SSE with the final decision. [Req 3, 4]
- [x] 16. Dispatch (~741): `flags.includes('sovereign-tier-3')` → `streamExternalCompletion`
      (`modelId = executedModelId`; audit unchanged — resolve is identity); else `generate()`. [Req 6]

## Checkpoint — Bedrock path untouched

- [x] 17. `npm run build` clean; `npm test` green (no env → all reasons/flags unchanged). [checkpoint]

## Wave 5 — Pricing [Req 7]

- [x] 18. `src/frontend/pricing-config.json`: add `models[qwen3.7-flash-2026-07-15]` +
      `models[MiniMax-M2.7-highspeed]` entries (displayName + per-1M prices from gateway). [Req 7]

## Wave 6 — Admin API + UI [Req 5]

- [x] 19. `src/routes/admin.routes.ts`: `GET/PUT /admin/tier3` (GET reads env, never returns key) +
      `GET /admin/restricted-terms`, `POST /admin/restricted-terms` (dup → 409), `DELETE
      /admin/restricted-terms/:term` (404 if missing). No `/test`. [Req 4, 5]
- [x] 20. `public/admin.html` Config tab: **Tier 3 — External Gateway** block (read-only env status:
      enabled, host, key ✓/—; model rows add/remove/enable; default radio; Save) + **Restricted
      words** block (list chips with Delete, inline add). Reuse modal/toast/badge patterns. [Req 4, 5]

## Wave 7 — Unit tests [Req 7]

- [x] 21. `tests/unit/routing-engine.test.ts`: classifier (PII / word hit case-insensitive / open);
      selectAutoModel (no-env = Tahap-1 equivalence; gateway off never candidate; gateway on +
      default → candidate; restricted + gateway on → `auto-tier-1`; access-denied drops candidate).
      Mock tier3.service + restricted-terms. [Req 7]
- [x] 22. `tests/unit/external-chat.service.test.ts`: mock fetch — SSE parse + deltas forwarded +
      usage captured; missing usage → chars/4; non-2xx sanitized; network → `model_error`. [Req 7]
- [x] 23. `tests/unit/tier3.service.test.ts`: list/set (upsert, delete-missing, single default,
      default not-in-list → cleared), getDefault fallback ordering. [Req 7]
- [x] 24. `tests/unit/restricted-terms.service.test.ts`: add/delete/list + cache invalidation on
      write. [Req 7]
- [x] 25. `npm run lint` zero errors on new/changed files. [Req 7]

## Wave 8 — Docs & observability [Req 1, 3, 6]

- [x] 26. Update `readme.md` routing/model sections + auto-deterministic docs "deferred" line.
      [Req 6]
- [ ] 27. Live smoke (when env/DB available): auto plain private → `auto-fixed-model`; restricted
      PII/word + gateway on → `auto-tier-1` (never T3); knowledge-found → private (candidate
      dropped); gateway on + empty retrieval + text-only → `auto-tier-3` external stream; multipart
      → Bedrock. Verify SSE reason/flags + audit. [Req 7]

## Deferred (later)
- [ ] Images/documents through T3 (multimodal content parts).
- [ ] T3 manual-user model selection; multi-gateway / per-model credentials; `/admin/tier3/test`.
- [ ] External retry/backoff; Bedrock fallback before first external byte.
