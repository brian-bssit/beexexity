# Requirements: Multi-Tenant API Key Management
## Feature: `multi-tenant-api-key`

---

## Overview
Transformasi gateway dari single shared-secret (`GHOSTMEET_API_KEY`) menjadi sistem API key multi-tenant dengan database-backed authentication, per-application billing mode, dan conditional end-user cost tracking. Admin-only management. Cutover clean — tidak ada backward compatibility dengan legacy key.

## Glossary
- **Application:** Konsumen eksternal LLM Gateway (contoh: GhostMeet, ChatBot HR). Satu app bisa punya banyak API key.
- **Billing Mode:** `PER_APP` — biaya diatribusikan ke application saja, tanpa end-user. `PER_USER` — biaya diatribusikan per end-user (email) yang dikirim consuming app via header.
- **API Key Prefix:** 16 karakter pertama key untuk identifikasi di UI (sesuai `VARCHAR(16)` di schema). Full key hanya ditampilkan sekali saat pembuatan.

---

## Requirements

### [Req 1] Application Management (Admin)
**User Story:** Admin dapat membuat, melihat, mengubah status, dan menghapus Application.

**Acceptance Criteria:**
1. `POST /api/v1/admin/applications` — Admin membuat application dengan `name` (unik), `billing_mode` (`PER_APP` | `PER_USER`), `created_by` (string metadata opsional).
2. `GET /api/v1/admin/applications` — List semua applications dengan kolom: name, billing_mode, is_active, created_at, jumlah API keys.
3. `PUT /api/v1/admin/applications/:id` — Admin mengubah name, billing_mode, atau is_active.
4. `DELETE /api/v1/admin/applications/:id` — Soft/hard delete application. API keys terkait ikut terhapus (CASCADE). Audit logs historical TETAP utuh (FK SET NULL).
5. Hanya admin yang bisa akses endpoint ini (middleware `authMiddleware` → `adminMiddleware`).

### [Req 2] API Key Lifecycle (Admin)
**User Story:** Admin dapat generate, lihat, deaktivasi, dan hapus API key untuk setiap application.

**Acceptance Criteria:**
1. `POST /api/v1/admin/applications/:id/keys` — Generate API key baru. Format: `bex_` + 32 hex random chars. Full key ditampilkan SEKALI di response. DB hanya menyimpan `key_prefix` (16 char pertama) dan `key_hash` (SHA-256).
2. `GET /api/v1/admin/applications/:id/keys` — List keys untuk application: key_prefix, name, is_active, created_at, last_used_at. Full key TIDAK PERNAH dikembalikan.
3. `PUT /api/v1/admin/keys/:id` — Deaktivasi key (set is_active = false). Request dengan key tersebut langsung ditolak.
4. `DELETE /api/v1/admin/keys/:id` — Hapus permanen. Audit logs historical SET NULL.
5. Validasi API key menggunakan `crypto.timingSafeEqual` — tahan timing attack.
6. Last_used_at ter-update setiap kali key dipakai untuk inference.

### [Req 3] API Key Authentication Middleware
**User Story:** External app mengirim request dengan header `x-api-key`, middleware memvalidasi dan me-resolve identitas application.

**Acceptance Criteria:**
1. Middleware membaca header `x-api-key`. Missing → `401 MISSING_API_KEY`.
2. Hash key dengan SHA-256, lookup ke `api_keys` JOIN `applications`.
3. Key tidak ditemukan atau is_active=false → `401 INVALID_API_KEY`.
4. Application is_active=false → `401 APPLICATION_INACTIVE`.
5. Jika `billing_mode = PER_USER`: middleware membaca header `x-username`. Missing atau string kosong (`""`) → `400 USERNAME_REQUIRED`. Value adalah string email — TIDAK divalidasi ke tabel users (decoupled identity).
6. Jika `billing_mode = PER_APP`: header `x-username` diabaikan (jika ada). Username di audit_logs = NULL.
7. Middleware attach context ke `req`: `{ apiKeyId, applicationId, applicationName, billingMode, username }`.
8. `req.user` TIDAK lagi hardcoded ghostmeet — identitas berasal dari application yang ter-resolve. Struktur field (`sub`, `username`, `role`) tetap di-populate untuk backward compatibility dengan downstream code yang membaca `req.user.sub`.

### [Req 4] Legacy Auth Removal
**User Story:** Sistem lama (`GHOSTMEET_API_KEY`) dihapus sepenuhnya. Tidak ada fallback.

**Acceptance Criteria:**
1. Environment variable `GHOSTMEET_API_KEY` dihapus dari `.env`, `.env.production`, `cloudbuild.yaml`.
2. `config.auth.apiKey` dihapus dari `src/config/index.ts`.
3. Logic validasi single-key di `apiKeyAuthMiddleware` diganti dengan DB lookup (Req 3).
4. Tidak ada backward compatibility — request dengan format lama akan dapat `401`.

### [Req 5] Audit Logging & Cost Attribution
**User Story:** Setiap inference request tercatat dengan `api_key_id` dan `application_id` untuk cost tracking granular.

**Acceptance Criteria:**
1. Kolom `api_key_id` (UUID, FK → api_keys ON DELETE SET NULL) dan `application_id` (UUID, FK → applications ON DELETE SET NULL) ditambahkan ke `audit_logs`.
2. Kolom `username` di `audit_logs` saat ini `NOT NULL` — harus di-ALTER ke nullable karena `PER_APP` mode tidak menyertakan username.
3. `auditService.log()` menulis `api_key_id` dan `application_id` dari request context.
4. Index: `(application_id, timestamp)`, `(api_key_id, timestamp)`, `(username, timestamp) WHERE username IS NOT NULL`.

### [Req 6] Cost Reporting (Extended)
**User Story:** Admin dapat filter dan agregasi cost report berdasarkan Application, API Key, dan Username.

**Acceptance Criteria:**
1. `GET /api/v1/admin/usage/cost` menerima query params baru: `applicationId`, `apiKeyId`, `username`.
2. Response mencakup grouping berdasarkan filter yang dipilih.
3. Kolom "Application" dan "API Key" muncul di tabel cost report (di samping "Username" dan "Cost").
4. Query existing (tanpa filter baru) tetap berfungsi — additive, bukan breaking change.
5. Format response diperluas (tambahan field), field existing tidak berubah nama/posisi.

### [Req 7] Admin Dashboard
**User Story:** Admin dapat mengelola Applications dan API Keys melalui UI yang sama dengan admin dashboard existing.

**Acceptance Criteria:**
1. Tab baru "Applications & API Keys" di `/public/admin.html` dengan sub-view:
   - **List Applications:** Tabel (name, billing_mode, status, jumlah keys, actions). Tombol "New Application".
   - **Form Create/Edit Application:** Input name, billing_mode dropdown, is_active toggle.
   - **Application Detail:** List API keys dengan prefix, status, last_used, actions. Tombol "Generate New Key".
   - **Modal "Key Created":** Menampilkan full API key SEKALI dengan tombol copy. Warning "Simpan key ini sekarang — tidak akan ditampilkan lagi."
2. Tab "Usage & Cost" existing ditambah filter dropdown: Application, API Key Prefix.
3. Tabel cost menampilkan kolom "Application" dan "API Key" (di samping "Username").
4. Semua endpoint admin menggunakan auth existing (`authMiddleware` → `adminMiddleware`).

---

## Out of Scope (Eksplisit)
- Self-service key creation untuk non-admin user
- Rate limiting per API key
- Budget caps / alerting per application
- Validasi `x-username` terhadap internal user registry
- Perubahan pada routing engine, PII masking, atau sequential reasoning
