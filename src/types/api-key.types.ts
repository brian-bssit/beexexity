/**
 * Multi-tenant API key management types.
 * @see docs/features/multi-tenant-api-key/
 */

/** Registered consuming application. */
export interface Application {
  id: string;
  name: string;
  billing_mode: 'PER_APP' | 'PER_USER';
  created_by: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  /** Computed — number of API keys for this application (not stored). */
  key_count?: number;
}

/** API key record (partial — full key never returned after creation). */
export interface ApiKey {
  id: string;
  application_id: string;
  name: string;
  key_prefix: string;   // first 16 chars for UI identification
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
}

/** Full key response — returned ONCE at creation time. */
export interface ApiKeyCreated {
  id: string;
  key: string;          // full key — shown exactly once
  prefix: string;
  name: string;
}

/** Attached to Express.Request by apiKeyAuthMiddleware after validation. */
export interface ApiKeyContext {
  apiKeyId: string;
  applicationId: string;
  applicationName: string;
  billingMode: 'PER_APP' | 'PER_USER';
  username: string | null;  // from x-username header, null if PER_APP
}
