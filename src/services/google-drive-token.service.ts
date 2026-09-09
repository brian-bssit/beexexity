import { OAuth2Client } from 'google-auth-library';
import { query } from '../config/database.js';
import { config } from '../config/index.js';

/** Access token cache entry. */
interface CacheEntry {
  token: string;
  expiresAt: number; // epoch ms
}

/** In-memory token cache (not shared across instances — sufficient for Cloud Run max 10). */
const accessTokenCache = new Map<string, CacheEntry>();

/** TTL for cached access tokens: 50 min (tokens expire in 60 min, refresh before expiry). */
const CACHE_TTL_MS = 50 * 60 * 1000;

export class GoogleDriveNotAuthorizedError extends Error {
  constructor() {
    super('Google Drive not authorized');
    this.name = 'GoogleDriveNotAuthorizedError';
  }
}

export class GoogleDriveTokenRevokedError extends Error {
  constructor() {
    super('Google Drive token revoked');
    this.name = 'GoogleDriveTokenRevokedError';
  }
}

export interface DriveTokenRecord {
  id: string;
  userId: string;
  refreshToken: string;
  googleEmail: string;
  grantedScopes: string[];
  lastRefreshedAt: string | null;
}

/** Get a valid access token for a user. Auto-refreshes if cached token expired. */
export async function getValidAccessToken(userId: string): Promise<string> {
  // 1. Check cache first
  const cached = accessTokenCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  // 2. Fetch refresh token from DB
  const result = await query<{
    id: string;
    refresh_token: string;
    google_email: string;
    granted_scopes: string[];
    last_refreshed_at: string | null;
  }>(
    'SELECT id, refresh_token, google_email, granted_scopes, last_refreshed_at FROM user_google_drive_tokens WHERE user_id = $1',
    [userId],
  );

  if (result.rows.length === 0) {
    throw new GoogleDriveNotAuthorizedError();
  }

  const row = result.rows[0];

  // 3. Refresh token via OAuth2Client
  // Redirect URI not needed for token refresh — only for initial auth code exchange
  const oauth2Client = new OAuth2Client(
    config.google.driveClientId || config.google.clientId,
    config.google.clientSecret,
  );
  oauth2Client.setCredentials({ refresh_token: row.refresh_token });

  try {
    const { token } = await oauth2Client.getAccessToken();
    if (!token) throw new Error('Empty access token from refresh');

    // 4. Cache the token
    accessTokenCache.set(userId, {
      token,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    // 5. Update last_refreshed_at
    await query(
      'UPDATE user_google_drive_tokens SET last_refreshed_at = now(), updated_at = now() WHERE user_id = $1',
      [userId],
    ).catch(() => {}); // fire-and-forget, non-critical

    return token;
  } catch (err: unknown) {
    const msg = (err as Error).message || '';
    if (msg.includes('revoked') || msg.includes('deleted') || msg.includes('invalid_grant')) {
      // Token revoked by user — delete from DB
      await query('DELETE FROM user_google_drive_tokens WHERE user_id = $1', [userId]).catch(() => {});
      throw new GoogleDriveTokenRevokedError();
    }
    throw err;
  }
}

/** Store a refresh token after OAuth callback. */
export async function storeRefreshToken(
  userId: string,
  refreshToken: string,
  googleEmail: string,
  scopes: string[],
): Promise<void> {
  await query(
    `INSERT INTO user_google_drive_tokens (user_id, refresh_token, google_email, granted_scopes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id)
     DO UPDATE SET refresh_token = $2, google_email = $3, granted_scopes = $4, updated_at = now()`,
    [userId, refreshToken, googleEmail, scopes],
  );
  // Invalidate cache on token replacement
  accessTokenCache.delete(userId);
}

/** Check if user has authorized Google Drive access. */
export async function hasDriveToken(userId: string): Promise<boolean> {
  const result = await query(
    'SELECT 1 FROM user_google_drive_tokens WHERE user_id = $1',
    [userId],
  );
  return result.rows.length > 0;
}

/** Delete user's Drive token (user-initiated revocation). */
export async function deleteDriveToken(userId: string): Promise<void> {
  await query('DELETE FROM user_google_drive_tokens WHERE user_id = $1', [userId]);
  accessTokenCache.delete(userId);
}

/** Clear entire token cache (for testing). */
export function clearTokenCache(): void {
  accessTokenCache.clear();
}
