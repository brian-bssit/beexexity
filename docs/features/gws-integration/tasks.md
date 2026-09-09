# Tasks: Google Workspace Integration

**Estimated: ~12 working days**

---

## Wave 1: Foundation (Days 1-3)

### Week 1, Day 1

- [x] **1.1** Add env vars to `src/config/index.ts`: `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_DRIVE_TIMEOUT_MS` [Req FR-2]
- [x] **1.2** Migration 035: `user_google_drive_tokens` table [Req FR-2]
- [x] **1.3** `src/services/google-drive-token.service.ts` — OAuth token CRUD, refresh, in-memory Map cache (TTL 50 min), revocation detection [Req FR-2, FR-3]

### Week 1, Day 2

- [x] **1.4** `src/services/google-drive.service.ts` — Drive API v3 fetch + export (Docs→text, Sheets→CSV, Slides→text, binary files→existing extractor), 10s timeout, error mapping [Req FR-3]
- [x] **1.5** `src/services/url-interceptor.service.ts` — Regex extraction, Drive fetch orchestration, URL→placeholder replacement, >3 URLs warning [Req FR-1]

### Week 1, Day 3

- [x] **1.6** Auth routes: `GET /api/v1/auth/google-drive/status`, `GET /auth`, `GET /callback`, `DELETE /revoke` in `src/routes/auth.routes.ts` [Req FR-2]
- [x] **1.7** OAuth callback handler — code→token exchange, store refresh_token, redirect frontend [Req FR-2]

### Checkpoint

- [x] **CP-1** Run migration. Unit test token refresh/cache/revocation. Unit test regex against all URL formats.

---

## Wave 2: Pipeline Integration (Days 4-6)

### Week 1, Day 4

- [x] **2.1** Insert URL interceptor in `handleJsonInference()` (after model validation, before PII masking). Handle 401 (no token) as JSON error before SSE. [Req FR-1, FR-4]
- [x] **2.2** Modify PII masking: combine `cleanedPrompt + '\n\n' + extractedDocumentText` → mask → split back into maskedPrompt + maskedDocumentText [Req FR-4]

### Week 1, Day 5

- [x] **2.3** Update `classifySovereignTier()` in `routing-engine.service.ts` to accept `maskedDocumentText` and check both prompt and doc for PII/restricted terms [Req FR-4]
- [x] **2.4** Pass `maskedDocumentText` through `RoutingInput` → `RoutingDecision`. Ensure document PII forces `auto-tier-1` + `sovereign-tier-1` flag [Req FR-4]

### Week 1, Day 6

- [x] **2.5** Inject `extractedDocumentText` into context assembly (`context-assembly.service.ts`) as document context in system prompt [Req FR-3]
- [x] **2.6** Log Drive API calls in `audit.log()` via `orchestration_meta` JSONB: `{ action: 'gdrive_fetch', fileId, fileName, mimeType, durationMs, success, errorMessage }` [Req FR-5]

### Checkpoint

- [x] **CP-2** Integration test: URL → fetch → PII mask → routing decision (clean doc = normal, PII doc = Tier-1). Assert audit trail in orchestration_meta.

---

## Wave 3: Frontend (Days 7-8)

### Week 2, Day 7

- [x] **3.1** Frontend: URL detection on paste (regex in chat input handler), show badge `📎 Google Docs detected (ID: {fileId.substring(0,8)}...)` [Req FR-6]
- [x] **3.2** Frontend: Authorization modal (when GET /status returns `authorized: false`), OAuth popup window, retry original request after auth [Req FR-6]

### Week 2, Day 8

- [x] **3.3** Frontend: Loading state `⏳ Mengambil dokumen dari Google Drive...` during fetch phase [Req FR-6]
- [x] **3.4** Frontend: Error display for all Drive error scenarios (user-friendly Bahasa Indonesia messages) [Req FR-6]
- [x] **3.5** Frontend: Profile settings — revoke Drive access button [Req FR-2]

### Checkpoint

- [ ] **CP-3** Manual E2E: paste URL without auth → modal → auth → retry → SSE stream. Paste URL with auth → auto-fetch → SSE stream.

---

## Wave 4: Testing & Polish (Days 9-12)

### Week 2, Day 9-10

- [x] **4.1** Unit tests: URL interceptor regex (all formats, code blocks, query params, multiple URLs) [Req FR-1]
- [x] **4.2** Unit tests: google-drive-token.service (refresh, cache hit/miss, revocation, no-token) [Req FR-2]
- [x] **4.3** Unit tests: google-drive.service (export formats, error codes, timeout) [Req FR-3]
- [x] **4.4** Unit tests: Routing engine with maskedDocumentText (clean doc, PII doc, restricted-term doc) [Req FR-4]
- [x] **4.5** Unit tests: Inference routes with GWS URL (success path, no-token 401, Drive API errors → SSE error) [Req FR-1, FR-4]

### Week 2, Day 11

- [ ] **4.6** Integration tests: Full pipeline — URL → Drive fetch → PII mask → routing → SSE stream [Req All]
- [ ] **4.7** Integration tests: OAuth flow — auth URL, callback, token refresh, revocation [Req FR-2]

### Week 2, Day 12

- [x] **4.8** Audit trail verification: assert `audit_logs.orchestration_meta` contains gdrive_fetch records [Req FR-5]
- [ ] **4.9** E2E smoke test with real Google Docs (internal test docs, PII test doc, restricted-term doc) [Req All]
- [x] **4.10** Document accepted risks in readme.md and migration comment [Req NFR-2]

---

## Summary

| Wave | Days | Deliverables |
|---|---|---|
| 1: Foundation | 3 | Token service, Drive service, URL interceptor, DB migration, OAuth routes |
| 2: Pipeline Integration | 3 | Inference pipeline modification, routing engine update, audit |
| 3: Frontend | 2 | URL detection, auth modal, loading/error states |
| 4: Testing & Polish | 4 | Unit/integration/E2E tests, smoke test, docs |
| **Total** | **12** | Production-ready MVP |
