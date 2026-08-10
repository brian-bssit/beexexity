
# Design: Multi-Tenant API Key Management
## Feature: `multi-tenant-api-key`

---

## Architecture

### Data Flow (API Key Auth)

```
External App
  │  x-api-key: bex_a1b2c3d4e5f6...
  │  x-username: user@corp.com      (wajib jika PER_USER)
  ▼
apiKeyAuthMiddleware
  │  1. SHA-256(x-api-key)
  │  2. SELECT * FROM api_keys WHERE key_hash = $1 AND is_active = true
  │  3. JOIN applications WHERE id = api_keys.application_id AND is_active = true
  │  4. Baca billing_mode:
  │     PER_USER → wajibkan x-username header (kosong/missing → 400)
  │     PER_APP  → abaikan x-username, set username = null
  │  5. UPDATE api_keys SET last_used_at = NOW() WHERE id = $1
  │  6. Attach req.apiKeyContext = { apiKeyId, applicationId, applicationName, billingMode, username }
  │  7. Attach req.user = synthetic TokenPayload (sub, username, role: 'api_key')
  │  8. next()
  ▼
Inference Route (batch/generate)
  │  existing logic, baca req.apiKeyContext + req.user
  ▼
Audit Service
  │  INSERT audit_logs (..., api_key_id, application_id, username)
```

### Admin Flow

```
Admin Browser (sessionStorage JWT)
  │  GET/POST/PUT/DELETE /api/v1/admin/applications
  │  GET/POST/PUT/DELETE /api/v1/admin/applications/:id/keys
  ▼
authMiddleware → adminMiddleware
  │  existing role guard (req.user.role === 'admin')
  ▼
Admin Routes (new handlers)
  │  application.service.ts  — CRUD applications
  │  api-key.service.ts      — CRUD keys, hash/validate
  ▼
PostgreSQL (applications, api_keys tables)
```

---

## Components & Interfaces

### New Files

#### `src/services/application.service.ts`
```
createApplication(name, billingMode, createdBy) → Application
listApplications()                                   → Application[]
getApplication(id)                                   → Application | null
updateApplication(id, { name?, billingMode?, isActive? }) → Application
deleteApplication(id)                                → void (CASCADE keys)
```

#### `src/services/api-key.service.ts`
```
generateApiKey(applicationId, name)                   → { key: string, prefix: string, id: UUID }
  // generate: "bex_" + crypto.randomBytes(16).toString("hex")  → 36 chars
  // store:    prefix = key.substring(0, 16), hash = SHA-256(key)
  // return:   full key (shown ONCE to admin)

listKeysByApplication(applicationId)                  → ApiKey[]
deactivateKey(id)                                     → void  (is_active = false)
deleteKey(id)                                         → void
validateApiKey(key: string)                           → ApiKeyContext | null
  // hash key, lookup api_keys + JOIN applications
  // returns { apiKeyId, applicationId, applicationName, billingMode } or null
```

#### `src/types/api-key.types.ts`
```
Application {
  id: string; name: string; billing_mode: 'PER_APP' | 'PER_USER';
  created_by: string | null; is_active: boolean;
  created_at: string; updated_at: string;
  key_count?: number;   // computed, not stored
}

ApiKey {
  id: string; application_id: string; name: string;
  key_prefix: string; is_active: boolean;
  last_used_at: string | null; created_at: string;
}

ApiKeyContext {   // attached to Request by middleware
  apiKeyId: string;
  applicationId: string;
  applicationName: string;
  billingMode: 'PER_APP' | 'PER_USER';
  username: string | null;  // from x-username header, null if PER_APP
}
```

#### `src/routes/admin-applications.routes.ts`
```
// Semua route di-mount di /api/v1/admin (pakai authMiddleware → adminMiddleware)

GET    /applications              → listApplications()
POST   /applications              → createApplication(name, billing_mode, created_by)
GET    /applications/:id          → getApplication(id)
PUT    /applications/:id          → updateApplication(id, { name?, billing_mode?, isActive? })
DELETE /applications/:id          → deleteApplication(id)

GET    /applications/:id/keys     → listKeysByApplication(applicationId)
POST   /applications/:id/keys     → generateApiKey(applicationId, name)
PUT    /keys/:id                  → deactivateKey(id)
DELETE /keys/:id                  → deleteKey(id)
```

### Modified Files

#### `src/middleware/auth.middleware.ts` — apiKeyAuthMiddleware

**Before:** Single GHOSTMEET_API_KEY env var, timingSafeEqual against config, hardcoded ghostmeet user.

**After:**
- Hapus import `config.auth.apiKey`, ganti dengan `validateApiKey()` dari `api-key.service.ts`
- Flow: baca `x-api-key` header → hash → DB lookup → resolve billing_mode → enforce `x-username` → attach context
- Populate `req.user`: synthetic TokenPayload
  - `sub`: applicationId (UUID)
  - `username`: applicationName
  - `role`: `'api_key'` (bukan 'user' atau 'admin' — cegah akses admin route)
  - `iat`/`exp`: synthetic ±1 jam dari now
- Attach `req.apiKeyContext` (perlu extend Express Request type)
- Error response codes: 401 MISSING_API_KEY, 401 INVALID_API_KEY, 401 APPLICATION_INACTIVE, 400 USERNAME_REQUIRED

#### `src/types/auth.types.ts` — TokenPayload
- Tambah `role: 'admin' | 'user' | 'api_key'` (extend union)

#### Express Request augmentation
- Extend existing `declare module 'express'` block di auth.middleware.ts — tambah `apiKeyContext?: ApiKeyContext`

#### `src/types/audit.types.ts` — AuditEntry
- Tambah: `apiKeyId?: string`, `applicationId?: string`
- Tandai `apiKeyUsed?: boolean` sebagai **deprecated** (computed: `apiKeyId != null`)
- Karena field baru nullable, downstream code tidak pecah

#### `src/services/audit.service.ts`
- Parameter tambahan dari `req.apiKeyContext`:
  - `apiKeyId` ← `req.apiKeyContext.apiKeyId`
  - `applicationId` ← `req.apiKeyContext.applicationId`
  - `username` ← `req.apiKeyContext.username` (override `req.user.username` jika API key)

#### `src/services/cost-reporting.service.ts` — getCostReport()
- Query params baru: `applicationId?`, `apiKeyId?`, `username?`
- WHERE clause additive — filter hanya diterapkan jika param tidak null
- Grouping: tambah `application_id`, `api_key_id`, `username` (tracing string) di SELECT
- Response type `CostReportResponse` diperluas dengan kolom opsional

#### `src/routes/inference.routes.ts` — POST /batch
- Hapus `billingContext.billedUserId` / `billingContext.billedGroup` dari body kontrak
- Ganti: baca `req.apiKeyContext.username` untuk end-user identification
- Backward compat: TIDAK ADA. GhostMeet harus update kirim `x-username` header.

#### `src/config/index.ts`
- Hapus `auth.apiKey` (line 82)
- Hapus komentar terkait GHOSTMEET_API_KEY

#### `public/admin.html`
- Tab baru: "Applications & API Keys"
- Tab "Usage & Cost": filter dropdown + kolom baru
- (Detail UI di requirements.md §Req 7)

---

## Data Models

### Migration 022 — `022_applications_api_keys.sql`

```sql
CREATE TABLE applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL UNIQUE,
    billing_mode VARCHAR(20) NOT NULL DEFAULT 'PER_APP'
        CHECK (billing_mode IN ('PER_APP', 'PER_USER')),
    created_by VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    key_prefix VARCHAR(16) NOT NULL,
    key_hash VARCHAR(255) NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_keys_application ON api_keys(application_id);
-- key_hash UNIQUE constraint already creates an index — no separate index needed
```

### Migration 023 — `023_alter_audit_logs.sql`

```sql
-- Nullable username untuk PER_APP mode
ALTER TABLE audit_logs ALTER COLUMN username DROP NOT NULL;

-- FK ke api_keys dan applications
ALTER TABLE audit_logs
    ADD COLUMN api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    ADD COLUMN application_id UUID REFERENCES applications(id) ON DELETE SET NULL;

-- Index untuk cost queries
CREATE INDEX idx_audit_logs_app_time ON audit_logs(application_id, timestamp);
CREATE INDEX idx_audit_logs_key_time ON audit_logs(api_key_id, timestamp);
CREATE INDEX idx_audit_logs_user_time ON audit_logs(username, timestamp)
    WHERE username IS NOT NULL;
```

Kolom `api_key_used` (dari migration 019) **tidak dihapus** — disimpan untuk backward compat query, tapi tidak lagi ditulis oleh kode baru. Dapat di-drop di migration cleanup terpisah di masa depan.

---

## Error Handling

| Skenario | HTTP | Error Code | Response |
|:---|:---|:---|:---|
| `x-api-key` header missing | 401 | `MISSING_API_KEY` | `{"error": "MISSING_API_KEY", "message": "API key required"}` |
| Key tidak ditemukan di DB | 401 | `INVALID_API_KEY` | `{"error": "INVALID_API_KEY", "message": "Invalid or deactivated API key"}` |
| Key found tapi is_active=false | 401 | `INVALID_API_KEY` | Sama di atas (tidak dibedakan — cegah enumeration) |
| Application is_active=false | 401 | `APPLICATION_INACTIVE` | `{"error": "APPLICATION_INACTIVE", "message": "Application is deactivated"}` |
| PER_USER tanpa `x-username` | 400 | `USERNAME_REQUIRED` | `{"error": "USERNAME_REQUIRED", "message": "x-username header required for this application"}` |
| `x-username` string kosong | 400 | `USERNAME_REQUIRED` | Sama di atas |
| Admin endpoint tanpa token JWT | 401 | `MISSING_TOKEN` | Existing behavior (authMiddleware) |
| Admin endpoint non-admin JWT | 403 | `ACCESS_DENIED` | Existing behavior (adminMiddleware) |
| API key role (`api_key`) akses admin endpoint | 403 | `ACCESS_DENIED` | adminMiddleware: `req.user.role !== 'admin'` |
| DB error saat lookup key | 500 | `INTERNAL_ERROR` | `{"error": "INTERNAL_ERROR", "message": "Authentication service unavailable"}` |
| Generate key — app tidak ditemukan | 404 | `APPLICATION_NOT_FOUND` | `{"error": "APPLICATION_NOT_FOUND", "message": "Application not found"}` |
| Create application — name duplikat | 409 | `DUPLICATE_NAME` | `{"error": "DUPLICATE_NAME", "message": "Application name already exists"}` |

---

## Key Design Decisions

1. **`role: 'api_key'` vs gabung dengan `user`.** Dipisah agar admin middleware (`role !== 'admin'`) otomatis memblokir API key dari akses admin route. Tidak perlu middleware tambahan.

2. **Decoupled identity.** `x-username` adalah string opaque — tidak ada FK lookup ke `users` table. Sesuai NFR-4 dari requirements asli.

3. **Additive query untuk cost report.** Filter `applicationId`/`apiKeyId`/`username` baru bersifat opsional — query tanpa filter berfungsi identik dengan existing. Response type diperluas tapi tidak mengubah field existing.

4. **Kolom `api_key_used` tidak di-drop.** Migration 019 sudah mendeploy kolom ini ke production. Drop di migration baru berisiko jika ada rollback. Dibiarkan stale — ditandai deprecated.

5. **No backward compat.** GhostMeet harus update sebelum deployment. Tidak ada grace period dual-auth.
