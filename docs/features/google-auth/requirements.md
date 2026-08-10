# Feature: Google Account Authentication (OAuth 2.0) 
**Epic:** Enterprise Access & User Experience  

## 1. Executive Summary
Enable seamless, secure sign-up and sign-in using Google Accounts via OpenID Connect (OIDC). This feature introduces Just-In-Time (JIT) user provisioning, allowing authorized users to self-service onboard without waiting for manual admin creation, while maintaining strict enterprise security via Google Cloud WAF domain whitelisting.

## 2. Context & Architectural Constraints
To ensure minimal disruption to the existing codebase, the following architectural rules apply:
*   **Identity Mapping:** The existing `users.username` column already stores email addresses for all standard users. We will **reuse this column** as the primary email identifier. No new `email` column is required.
*   **Security & Domain Restriction:** Access control (restricting logins to specific corporate domains) is handled at the network edge by **Google Cloud WAF/IAP**. The Node.js backend **does not** need to implement custom domain validation logic.
*   **Session Isolation:** The existing JWT (HS256) generation and `auth.middleware.ts` remain completely untouched. Google is strictly used for initial identity verification.

## 3. User Stories
*   **As an** enterprise user, **I want** to sign in with my Google Account, **so that** I don't have to remember or manage a separate password for the gateway.
*   **As a** new authorized employee, **I want** to automatically receive an account upon my first Google login (JIT), **so that** I can start working immediately without waiting for IT to provision me.
*   **As an** existing local user, **I want** to link my Google Account to my existing username, **so that** I can seamlessly switch between password and Google login methods.
*   **As a** frontend user, **I want** the UI to hide "Change Password" options when I log in via Google, **so that** I am not confused by irrelevant settings.

## 4. Functional Requirements

### 4.1 Database Schema (Migration 009)
*   **Make Password Nullable:** Alter the `users` table to allow `password` to be `NULL` for Google-authenticated users.
*   **Add OAuth Tracking:** Add `google_id` (VARCHAR, UNIQUE) to store the Google `sub` claim.
*   **Add Provider Tracking:** Add `auth_provider` (VARCHAR, default `'local'`) to distinguish between local and Google users for UI logic.

### 4.2 Backend API & Logic
*   **New Endpoint:** `POST /api/v1/auth/google`
*   **Token Verification:** Backend must cryptographically verify the Google ID Token using the `google-auth-library` (verifying `audience` matches `GOOGLE_CLIENT_ID`).
*   **JIT Provisioning & Account Linking Logic:**
    1.  *Check 1:* Query user by `google_id`. If found, proceed to JWT generation.
    2.  *Check 2:* If not found, query user by `username` (which holds the email). If found, update the record to link the `google_id` and set `auth_provider = 'google'`.
    3.  *Check 3:* If neither exists, auto-register a new user with `username = email`, `google_id`, `auth_provider = 'google'`, and `password = NULL`.
*   **Response:** Return the standard HS256 JWT and an `authProvider: 'google'` flag.

### 4.3 Frontend UI (`public/index.html`)
*   **Google Identity Services (GIS):** Load the GIS script and render the standardized "Sign in with Google" button on the login screen.
*   **Credential Handling:** Capture the `credential` (ID Token) from the GIS callback and `POST` it to `/api/v1/auth/google`.
*   **State Management:** Store `authProvider` in `localStorage` alongside the JWT.
*   **Conditional UI:** Hide "Forgot Password" and "Change Password" UI elements if `localStorage.getItem('authProvider') === 'google'`.

## 5. Non-Functional Requirements

| Category | Requirement |
| :--- | :--- |
| **Security** | Google ID Tokens must be verified server-side. Passwords for Google users must remain `NULL`. Domain restriction is enforced by WAF, not application code. |
| **Performance** | Google token verification and DB lookup must add **< 200ms** latency to the login process. |
| **Reliability** | If the Google API is unreachable, the login must fail gracefully with a clear error message, without crashing the Express server. |
| **Infrastructure** | `GOOGLE_CLIENT_ID` must be injected into Cloud Run via `cloudbuild.yaml` environment variables. |

## 6. Acceptance Criteria (BDD)

### Scenario 1: First-Time Google Login (JIT Provisioning)
- **GIVEN** a valid Google ID Token from a user not in the database
- **WHEN** the token is sent to `POST /api/v1/auth/google`
- **THEN** a new user record is created with `auth_provider = 'google'` and `password = NULL`
- **AND** a valid JWT is returned to the client.

### Scenario 2: Returning Google Login
- **GIVEN** a valid Google ID Token from an existing Google user
- **WHEN** the token is sent to the endpoint
- **THEN** the existing user is found via `google_id`
- **AND** a valid JWT is returned without modifying the database record.

### Scenario 3: Existing Local User Links Google Account
- **GIVEN** a valid Google ID Token where the email matches an existing local user's `username`
- **WHEN** the token is sent to the endpoint
- **THEN** the existing user's record is updated with the `google_id` and `auth_provider` is changed to `'google'`
- **AND** a valid JWT is returned.

### Scenario 4: Frontend UI State
- **GIVEN** a user successfully logs in via Google
- **WHEN** the frontend renders the dashboard/settings
- **THEN** the "Change Password" and "Forgot Password" buttons are hidden.

## 7. Non-Goals (Out of Scope)
*   **Backend Domain Restriction:** We will not write code to check `email.endsWith('@company.com')`. This is strictly handled by GCP WAF/IAP.
*   **Google Workspace Admin SDK:** We are not integrating with Google Admin to provision/deprovision users automatically when they leave the company.
*   **Other Social Logins:** Microsoft, GitHub, or Apple logins are not included in this release.

## 8. Implementation Tasks (Traceability)

- [ ] **TASK-001:** Create `migrations/009_google_oauth.sql` (Alter users table).
- [ ] **TASK-002:** Install `google-auth-library` and update `config/index.ts` with `GOOGLE_CLIENT_ID`.
- [ ] **TASK-003:** Implement `loginWithGoogle()` in `src/services/auth.service.ts` (JIT logic).
- [ ] **TASK-004:** Add `POST /auth/google` route in `src/routes/auth.routes.ts`.
- [ ] **TASK-005:** Update `public/index.html` with GIS script, button, and callback handler.
- [ ] **TASK-006:** Update frontend UI logic to hide password management for Google users.
- [ ] **TASK-007:** Update `cloudbuild.yaml` to inject `GOOGLE_CLIENT_ID` into Cloud Run env vars.
- [ ] **TASK-008:** Write unit tests for `auth.service.ts` (mocking `google-auth-library`).