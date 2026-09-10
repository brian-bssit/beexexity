# Design: Google Workspace Integration

---

## Architecture

### Insertion point in inference pipeline

URL interceptor sits between model validation and PII masking — document text must be fetched before masking, so the combined string (prompt + doc) is masked atomically.

```
handleJsonInference() flow (modified):
  1. Validate prompt (non-empty, <64K)
  2. Validate modelId
  ── NEW ──────────────────────────────────────
  2b. URL Interceptor:
      a. Regex extract fileId from raw prompt
      b. If no GWS URL → skip (zero cost)
      c. Lookup user Drive token in DB
      d. If no token → 401 { error: 'GOOGLE_DRIVE_NOT_AUTHORIZED', authUrl }
      e. Fetch document via Drive API (10s timeout)
      f. Replace URL with `[Google Docs: {title}]` placeholder
      g. Store extractedDocumentText
  ─────────────────────────────────────────────
  3. PII mask separately:
     → maskedPrompt + promptPiiDetected  (from raw prompt)
     → maskedDocText + docPiiDetected    (from extractedDocumentText)
     → piiDetected = promptPiiDetected || docPiiDetected
     → combinedMaskedText = maskedPrompt + '\n\n' + maskedDocText
     (NOT combined-then-split — masker changes string length, split by position would misalign)
  4. Prompt length check (against maxContextCharacters)
  5+. Existing flow unchanged
     - maskedDocumentText passed into RoutingInput.maskedDocumentText
     - classifySovereignTier checks both maskedPrompt AND maskedDocumentText
     - context assembly injects extractedDocumentText (not masked — LLM needs real content)
       into system prompt as document context
```

### Why before PII masking, not after

- Document may contain PII. Routing on prompt-only mask means doc PII reaches sovereign gate unseen.
- Separate masking avoids the length-change problem (NIK `[NIK_1]` is shorter than 16 digits — split position misaligns).
- `piiDetected` is OR'd from both — sovereignty gate sees full picture.
- Combined masked text used only for routing context, never split back.

### OAuth flow (separate from existing GIS login)

Existing login uses GIS (public client, OIDC, no refresh token). Drive needs OAuth 2.0 Web Server flow (confidential client, auth code grant, refresh token). **Separate OAuth 2.0 Web Client credential** in the same Google Cloud project.

```
Frontend                          Backend                         Google
  │                                 │                               │
  ├─ GET /auth/google-drive/status ─┤                               │
  │← { authorized: false }          │                               │
  │                                 │                               │
  ├─ GET /auth/google-drive/auth ───┤                               │
  │← { authUrl }                    │                               │
  │                                 │                               │
  ├─ (redirect user to authUrl) ────┼───────────────────────────────┤
  │                                 │                               │
  │                                 │  (user consents, auth code)   │
  │                                 ├─ GET /auth/google-drive/ ────┤
  │                                 │   callback?code=xxx           │
  │                                 │← { access_token, refresh }    │
  │                                 │                               │
  │                                 ├─ store refresh_token (DB)     │
  │                                 ├─ cache access_token (memory)  │
  │                                 └─ serve mini-page → postMessage → close popup │
  │                                                               │
  ├─ (retry original request) ──────┤                               │
  │← SSE stream                     │                               │
```

### OAuth popup communication

Popup flow:
1. Frontend opens `window.open(authUrl, 'google-auth', 'width=500,height=600')`
2. User consents → Google redirects to `/api/v1/auth/google-drive/callback`
3. Backend exchanges code for tokens, stores refresh_token
4. Backend serves a mini-page that calls `window.opener.postMessage({ type: 'gd_auth_complete' }, origin)` then `window.close()`
5. Main window listens: `window.addEventListener('message', handler)` — on `gd_auth_complete`, retry original request

```
getValidAccessToken(userId)
  1. Query DB for encrypted refresh_token
  2. No row → throw GoogleDriveNotAuthorizedError
  3. Check in-memory Map cache (TTL 50 min)
  4. Cache hit → return cached access_token
  5. Cache miss → call OAuth2Client.getAccessToken() with refresh_token
  6. Success → cache in Map, update last_refreshed_at, return token
  7. Fail (revoked) → delete DB row, throw GoogleDriveTokenRevokedError
```

---

## Components & Interfaces

### New files

| File | Role |
|---|---|
| `src/services/url-interceptor.service.ts` | Regex extraction + orchestration |
| `src/services/google-drive.service.ts` | Drive API v3 fetch + export |
| `src/services/google-drive-token.service.ts` | OAuth token storage, refresh, cache |

### Modified files

| File | Change |
|---|---|
| `src/routes/inference.routes.ts` | Insert URL interceptor in handleJsonInference (step 2b) |
| `src/routes/auth.routes.ts` | Add 4 Drive OAuth endpoints |
| `src/services/routing-engine.service.ts` | Accept maskedDocumentText in classifySovereignTier |
| `src/services/audit.service.ts` | Support gdrive_fetch in orchestration_meta |
| `src/services/context-assembly.service.ts` | Inject documentText into system prompt |
| `src/config/index.ts` | Add GOOGLE_CLIENT_SECRET, GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_TIMEOUT_MS |
| `public/index.html` | URL detection badge, auth modal, loading state |

### Interfaces

```typescript
// url-interceptor.service.ts
interface UrlInterceptorResult {
  cleanedPrompt: string;           // prompt with URL replaced by placeholder
  extractedDocumentText: string;   // raw document content (pre-PII)
  documentTitle: string;
  fileId: string;
  mimeType: string;
}

interface GoogleWorkspaceUrl {
  fileId: string;
  fullUrl: string;
  type: 'document' | 'spreadsheet' | 'presentation' | 'drive';
}

// google-drive.service.ts
interface DriveFetchResult {
  title: string;
  text: string;
  mimeType: string;
  sizeBytes: number;
}

// google-drive-token.service.ts
interface DriveTokenRecord {
  id: string;
  userId: string;
  refreshToken: string;  // encrypted at rest by GCP Cloud SQL
  googleEmail: string;
  grantedScopes: string[];
  lastRefreshedAt: string | null;
}
```

### Regex

```typescript
// Matches all Google Workspace URL formats
const GWS_URL_REGEX = /(?<!`)(?:https?:\/\/(?:docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/|drive\.google\.com\/file\/d\/)([a-zA-Z0-9_-]{10,100}))(?:[\/?#]\S*)?(?!`)/g;
```

---

## Data Models

### Migration 035: `user_google_drive_tokens`

```sql
CREATE TABLE user_google_drive_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL,              -- at-rest encrypted by GCP Cloud SQL
  google_email VARCHAR(255) NOT NULL,
  granted_scopes TEXT[] NOT NULL DEFAULT ARRAY[
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/documents.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/presentations.readonly'
  ],
  last_refreshed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);
CREATE INDEX idx_user_gdrive_tokens_user_id ON user_google_drive_tokens(user_id);
```

**No migration 036.** Audit logs use existing `audit_logs.orchestration_meta` JSONB.

### Token cache (in-memory)

```typescript
// google-drive-token.service.ts
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();
// TTL: 50 minutes (access tokens expire in 60 min)
// Cleanup: lazy eviction on read (check expiresAt)
```

---

## Error Handling

| Scenario | HTTP | Frontend Handling |
|---|---|---|
| No Drive token | 401 `GOOGLE_DRIVE_NOT_AUTHORIZED` + `authUrl` | Show auth modal → redirect OAuth |
| Token revoked (refresh fails) | 401 `GOOGLE_DRIVE_TOKEN_REVOKED` | Show "Sesi Google berakhir" modal → re-auth |
| Drive API 403 | SSE `error` → `GOOGLE_DRIVE_ACCESS_DENIED` | "Anda tidak memiliki akses ke dokumen ini" |
| Drive API 404 | SSE `error` → `GOOGLE_DRIVE_NOT_FOUND` | "Dokumen tidak ditemukan atau sudah dihapus" |
| Drive API 429 | SSE `error` → `GOOGLE_DRIVE_RATE_LIMITED` | "Terlalu banyak permintaan, coba lagi dalam 1 menit" |
| Drive timeout (10s) | SSE `error` → `GOOGLE_DRIVE_TIMEOUT` | "Dokumen terlalu besar, silakan upload manual" |
| PII masker throws | 500 (fail-closed) | "Gagal memproses dokumen" |
| Document too large | SSE `error` → `GOOGLE_DRIVE_TOO_LARGE` | "Dokumen melebihi batas 10MB" |

**Auth errors (no token, revoked) are returned as 401 JSON before SSE setup.** Drive API errors during fetch are emitted as SSE `error` events after SSE headers are set.

---

## Security Considerations

- **No app-level token encryption:** Accepted risk. GCP Cloud SQL at-rest encryption + IAM restrict DB access. Encryption key in env var is same threat model as DB password. Documented in migration comment.
- **Zero-trust egress:** Every Drive API call uses the requesting user's OAuth token, not a service account. System never has blanket Drive access.
- **PII fail-closed:** Prompt and doc masked separately, then combined for routing. If masker throws, entire request rejected.
- **Restricted terms:** `classifySovereignTier` checks document text for restricted lexicon (rahasia bank, dll). Hit → force Tier-1, never Tier-3.
- **No write scopes:** All requested scopes are read-only.
- **Audit trail:** Every fetch logged to `audit_logs.orchestration_meta` with user_id, file_id, duration.

---

## Addendum: Folder support (2026-09-10)

Folder links (`drive.google.com/drive/folders/{id}`, incl. `/drive/u/{n}/folders/{id}`) previously fell through the interceptor regex and reached the model as a raw URL — unreadable.

- **Detection:** `GWS_URL_REGEX` gains the folder alternatives; `GoogleWorkspaceUrl.type` gains `'folder'`. Placeholder: `[Google Folder: {name}]`.
- **Fetch:** `fetchFolder(folderId, token)` in `google-drive.service.ts` — `files.get` for the folder name, then `files.list` (`'{id}' in parents and trashed=false`, `pageSize=100`, paginated via `nextPageToken`, `supportsAllDrives`), depth-first-limited to **1 nested level**.
- **Per-file fetch reuses `fetchDocument()`** unchanged — Google-native export/downlink + `extractDocumentText()`.
- **Limits:** ≤20 files, ≤50MB total, ≤10MB per file. Batches of 4 via `Promise.allSettled`; a failed file is logged and skipped (turn never blocked). Empty → `"Folder kosong atau tidak ada dokumen yang bisa dibaca."`
- **Assembly:** documents joined under `===== n. {name} =====` into a single `DriveFolderResult` (`DriveFolderResult extends DriveFetchResult`, `+fileCount`). `title` = folder name, `mimeType` = `application/vnd.google-apps.folder`.
- **Downstream unchanged:** `interceptUrls` dispatches on `type === 'folder'`; the caller still receives one `extractedDocumentText` blob. No changes in `inference.routes.ts`.
- **Timeout:** a fresh `AbortSignal.timeout(driveTimeoutMs)` per request — a shared signal would abort the whole crawl once the first request's deadline elapsed.

---

## Addendum: Sticky session document context (2026-09-10)

A fetched GWS document is internal material, but the text previously lived only in the turn that carried the URL. A follow-up turn therefore had **no** document signal: `selectAutoModel` saw `documentText === undefined`, set `tier3-candidate`, and an empty knowledge retrieval escalated the conversation to the external Tier-3 gateway. It was also answered without the document content.

- **Storage:** migration 036 adds `sessions.internal_document_context` / `internal_document_title`. Written by `setInternalDocumentContext()` on the fetching turn with the **masked** extraction, sliced to 50k (same cap as the system-prompt injection); failures are logged, never fatal.
- **Read-back:** every turn computes `effectiveDocumentText = maskedDocumentText ?? session.internal_document_context`, plus `documentTextFromSession` (true only when the fallback is used).
- **Routing:** `RoutingInput.maskedDocumentText` receives the effective text → `AutoModelContext.documentText` is set → `tier3-candidate` is never emitted, and `classifySovereignTier` keeps scanning the document for PII/restricted terms on later turns. New audit flag: `sovereign-internal-document`.
- **Prompt:** the same text feeds the `[Dokumen Google Drive: …]` system-prompt section, so follow-ups can answer about it. The section now injects the **masked** text (it previously used the raw extraction).
- **Semantics:** sticky for the session; a later turn pasting a new document replaces the stored context. Rows are removed with the session by normal expiry cleanup.
