# Feature Requirements: Google Workspace Integration

**Version:** 1.0 (MVP)
**Status:** Draft
**Last Updated:** 2026-09-09

---

## Overview

Users paste Google Workspace URLs (Docs, Sheets, Slides, Drive files) into chat. System fetches, extracts, PII-masks, and routes the content through existing inference pipeline — same sovereign-tier compliance as file uploads.

## Glossary

| Term | Definition |
|---|---|
| GWS | Google Workspace (Docs, Sheets, Slides, Drive) |
| Drive OAuth | OAuth 2.0 Web Server flow for Google Drive API (confidential client, auth code + refresh token) |
| GIS | Google Identity Services — existing login flow (OIDC, public client, no refresh token) |
| File ID | Unique Google Drive resource identifier (`[a-zA-Z0-9_-]{10,100}`) |
| URL Interceptor | New service: regex-parses prompt, extracts file IDs, orchestrates fetch |

## Constraints

- **Enterprise context:** System serves regulated users (banking). "Public-only" workaround is unacceptable — OAuth mandatory.
- **Existing Google auth is OIDC-only:** Uses `google-auth-library` for ID token verification (`OAuth2Client.verifyIdToken`). No `clientSecret`, no refresh token flow. Drive needs a **separate OAuth 2.0 Web Client** credential (confidential client, auth code grant).
- **No pgcrypto:** Not in PostgreSQL stack. Token security relies on GCP Cloud SQL at-rest encryption + IAM (accepted risk — documented).
- **No Redis:** In-memory `Map<string, {token, expiry}>` for access token cache. Sufficient for Cloud Run max 10 instances.
- **Audit merged:** Google Drive API calls logged in existing `audit_logs.orchestration_meta` JSONB — no separate table.
- **PII fail-closed:** Prompt and doc text masked separately, then combined for routing. Masker throws → 500.
- **Sovereign-tier compliance:** Document content with PII/restricted terms → force Tier-1 (private Bedrock). Never external.

## Requirements

### FR-1: URL Detection & Extraction

System detects Google Workspace URLs in user prompt, extracts file ID.

**AC:**
- Regex matches all formats:
  - `docs.google.com/document/d/{fileId}`
  - `docs.google.com/spreadsheets/d/{fileId}`
  - `docs.google.com/presentation/d/{fileId}`
  - `drive.google.com/file/d/{fileId}`
- Handles query params (`?usp=sharing`), path suffixes (`/edit`, `/preview`), trailing slash
- Ignores URLs inside markdown code blocks (backtick-delimited)
- Multiple URLs: process first valid, warn if >3 detected
- Extracted file ID: 10-100 chars, `[a-zA-Z0-9_-]`

### FR-2: Google Drive OAuth

Users authorize read-only Google Drive access via OAuth 2.0 Web Server flow.

**AC:**
- Uses **separate OAuth 2.0 Web Client** credential (not the existing GIS login client)
- Requires new env vars: `GOOGLE_CLIENT_SECRET`, `GOOGLE_DRIVE_CLIENT_ID`
- Scopes requested: `drive.readonly`, `documents.readonly`, `spreadsheets.readonly`, `presentations.readonly`
- Authorization is one-time per user (refresh token persists)
- Refresh token stored in `user_google_drive_tokens` table (no app-level encryption for MVP — at-rest encryption + IAM is accepted risk)
- Access token cached in-memory (Map, TTL 50 min)
- Auto-refresh on expiry
- Revoked token detected (refresh fails) → delete from DB → re-prompt user

**API endpoints:**
```
GET  /api/v1/auth/google-drive/status    — check if user has valid token
GET  /api/v1/auth/google-drive/auth      — get OAuth URL (redirect to Google)
GET  /api/v1/auth/google-drive/callback  — OAuth callback (code → token exchange)
DELETE /api/v1/auth/google-drive/revoke  — user revokes access
```

### FR-3: Document Fetching

System fetches document content via Google Drive API v3.

**AC:**
| Google Type | Export Format | Extractor |
|---|---|---|
| Google Docs | `text/plain` | Plain text (no Markdown conversion needed — LLM handles it) |
| Google Sheets | `text/csv` | Existing CSV extractor (already outputs Markdown tables) |
| Google Slides | `text/plain` | Plain text (slide notes + content) |
| Drive files (PDF, DOCX, etc.) | Binary download | Existing `document-extractor.service.ts` |

- Timeout: 10s per file fetch
- No rate limiter for MVP (monitor and add if needed). Default quota: 100 req/100s/user.
- Error mapping:
  - 403 → "Anda tidak memiliki akses ke dokumen ini"
  - 404 → "Dokumen tidak ditemukan atau sudah dihapus"
  - 429 → "Terlalu banyak permintaan, coba lagi dalam 1 menit"
  - Timeout → "Dokumen terlalu besar, silakan upload manual"
  - Token revoked → "Sesi Google berakhir, silakan izinkan ulang"

### FR-4: PII Masking + Sovereign Routing

Extracted document text and prompt are PII-masked separately, then combined for routing.

**AC:**
- Prompt masked separately → `maskedPrompt`, `promptPiiDetected`
- Doc text masked separately → `maskedDocText`, `docPiiDetected`
- `piiDetected = promptPiiDetected || docPiiDetected`
- Combined for routing context: `maskedPrompt + '\n\n' + maskedDocText`
- PII masker runs BEFORE `classifySovereignTier()`
- Document PII/restricted terms → `auto-tier-1` (sovereign-tier-1 flag)
- Clean document → normal routing (may escalate to Tier-3 if knowledge empty)
- Masker throws → 500 (fail-closed)

### FR-5: Audit Trail

All Google Drive API calls logged.

**AC:**
- Logged in existing `audit_logs.orchestration_meta` JSONB (no new table)
- Fields: `action: 'gdrive_fetch'`, `fileId`, `fileName`, `mimeType`, `durationMs`, `success`, `errorMessage`
- Fire-and-forget (non-blocking)
- Admin dashboard: Google Drive usage stats queryable via existing audit queries

### FR-6: Frontend UX

Clear feedback during URL processing.

**AC:**
- URL detection badge: `📎 Google Docs detected (ID: {fileId.substring(0,8)}...)`
- Authorization modal when user hasn't granted access
- Loading state: `⏳ Mengambil dokumen dari Google Drive...`
- Error messages user-friendly (Bahasa Indonesia, non-technical)
- Success: document content seamlessly integrated into chat context

## Out of Scope (Phase 2+)

- MCP Server implementation
- Knowledge Base sync from Drive folders
- Google Drive Picker UI
- Write operations to Google Workspace
- Real-time collaboration
- App-level token encryption (accepted risk for MVP)
- Redis token cache (accepted risk for MVP)
