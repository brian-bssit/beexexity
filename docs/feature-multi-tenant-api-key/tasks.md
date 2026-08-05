# Tasks: Multi-Tenant API Key Management
## Feature: `multi-tenant-api-key`

---

## Phase 1 — Database & Core Services

- [ ] **1.1** Migration 022: buat tabel `applications` + `api_keys` dengan index. [Req 1, Req 2]
- [ ] **1.2** Migration 023: alter `audit_logs` — username nullable, tambah `api_key_id` + `application_id` FK, index. [Req 5]
- [ ] **1.3** `src/types/api-key.types.ts` — definisikan `Application`, `ApiKey`, `ApiKeyContext`. [Req 1, Req 2, Req 3]
- [ ] **1.4** `src/services/application.service.ts` — CRUD applications: create, list, get, update, delete. [Req 1.1–1.5]
- [ ] **1.5** `src/services/api-key.service.ts` — generate (hash + prefix), list, deactivate, delete, validateApiKey (DB lookup + timingSafeEqual). [Req 2.1–2.6, Req 3.2–3.4]
- [ ] **1.6** `tests/unit/api-key.service.test.ts` — test generate prefix+hash integrity, validateApiKey happy path + invalid, timingSafeEqual behavior. [Req 2.5–2.6]
- [ ] **1.7** `tests/unit/application.service.test.ts` — test CRUD operations, duplicate name rejection, CASCADE delete. [Req 1.1–1.5]

**Checkpoint — `npm test` & `npm run lint` harus pass sebelum lanjut.**

---

## Phase 2 — Middleware & Audit

- [ ] **2.1** Extend `TokenPayload` role union: tambah `'api_key'`. [Req 3.8]
- [ ] **2.2** Extend Express Request: tambah `apiKeyContext?: ApiKeyContext` di module augmentation. [Req 3.7]
- [ ] **2.3** Rewrite `apiKeyAuthMiddleware`: hapus GHOSTMEET_API_KEY flow, ganti dengan `validateApiKey()` DB lookup, conditional `x-username` enforcement, attach `req.apiKeyContext` + `req.user`. [Req 3.1–3.8]
- [ ] **2.4** Update `AuditEntry` type: tambah `apiKeyId?`, `applicationId?`, deprecate `apiKeyUsed`. [Req 5.1, 5.3]
- [ ] **2.5** Update `audit.service.ts`: tulis `api_key_id` + `application_id` + conditional `username` dari `req.apiKeyContext`. [Req 5.3]
- [ ] **2.6** Update `POST /batch` di inference routes: hapus `billingContext` dari body, ganti source dari `req.apiKeyContext`. [Req 3.7, Req 4.4]
- [ ] **2.7** Hapus legacy: `config.auth.apiKey` dari `src/config/index.ts`, `GHOSTMEET_API_KEY` dari `.env` + `.env.production` + `cloudbuild.yaml`. [Req 4.1–4.4]
- [ ] **2.8** `tests/unit/api-key-auth.middleware.test.ts` — test 6 skenario: key valid → next(), key invalid → 401, key inactive → 401, app inactive → 401, PER_USER tanpa username → 400, PER_USER username kosong → 400. [Req 3.1–3.6]

**Checkpoint — `npm test` & `npm run lint` harus pass. Semua 6 skenario middleware harus punya test coverage.**

---

## Phase 3 — Admin Routes & UI

- [ ] **3.1** `src/routes/admin-applications.routes.ts` — mount di `/api/v1/admin` dengan `authMiddleware` → `adminMiddleware`. Handler untuk semua endpoint applications + keys. [Req 1.5, Req 2, Req 7.4]
- [ ] **3.2** Register admin-applications router di `src/app.ts` (mount path). [Req 1.5]
- [ ] **3.3** Extend `getCostReport()`: query params `applicationId?`, `apiKeyId?`, `username?`. Additive WHERE, extended response type. [Req 6.1–6.5]
- [ ] **3.4** Admin UI: tab "Applications & API Keys" — list apps, create/edit form, key list per app, generate key modal (tampilkan sekali + copy button). [Req 7.1]
- [ ] **3.5** Admin UI: tab "Usage & Cost" — filter dropdown Application + API Key, kolom baru di tabel. [Req 7.2–7.3]
- [ ] **3.6** `tests/unit/admin-applications.routes.test.ts` — test CRUD endpoints: create app, list apps, update app, delete app, generate key, deactivate key, delete key, unauthorized access. [Req 1.5, Req 2, Req 7.4]

**Checkpoint — `npm test` & `npm run lint` harus pass. Test admin endpoints: CRUD apps, CRUD keys, cost filter.**

---

## Phase 4 — Final Cleanup & Validation

- [ ] **4.1** Run full test suite: `npm test`. Semua 371+ test + test baru (1.6, 1.7, 2.8, 3.6) harus pass. [All Req]
- [ ] **4.2** Run linter: `npx eslint src/ tests/`. Zero errors. [All Req]
- [ ] **4.3** Type-check: `npx tsc --noEmit`. Zero errors. [All Req]
- [ ] **4.4** Smoke test manual: generate key via admin UI → curl batch endpoint dengan key valid → verifikasi audit_logs entry ada `api_key_id` + `application_id`. [All Req]
- [ ] **4.5** Verifikasi deployment: cek `cloudbuild.yaml` tidak ada reference `GHOSTMEET_API_KEY`. Pastikan env production siap dengan credential baru. [Req 4.1]
