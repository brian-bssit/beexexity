import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { login, loginWithGoogle, changePassword } from '../services/auth.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { config } from '../config/index.js';
import { ErrorResponse } from '../types/error.types.js';
import { loginRateLimit } from '../middleware/security.middleware.js';
import {
  hasDriveToken,
  storeRefreshToken,
  deleteDriveToken,
} from '../services/google-drive-token.service.js';

/**
 * Sign the Drive OAuth `state` so the callback can prove the code belongs to the
 * user who started the flow. State = `<userId>.<HMAC-SHA256(userId, clientSecret)>`.
 * The callback is unauthenticated — a bare userId as state would let an attacker
 * write their own refresh token onto any account (login-CSRF). See /audit.
 */
function signDriveState(userId: string): string {
  const sig = createHmac('sha256', config.google.clientSecret).update(userId).digest('base64url');
  return `${userId}.${sig}`;
}

function verifyDriveState(state: string): string | null {
  const dot = state.indexOf('.');
  if (dot <= 0) return null;
  const userId = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = signDriveState(userId);
  const actual = `${userId}.${sig}`;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return userId;
}

/**
 * Auth routes — handles user authentication and password management.
 * @see Requirements 1.1, 1.2, 1.3, 1.4, 1.9
 */
const router = Router();

/**
 * POST /api/v1/auth/login
 * Authenticate user with username and password.
 * Returns JWT token and user profile on success, 401 on failure.
 * Rate limited: 5 attempts per 15 minutes per IP.
 */
router.post('/login', loginRateLimit, async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body;

  // Validate request body — both username and password are required
  if (!username || !password) {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'Username and password are required',
    };
    res.status(400).json(error);
    return;
  }

  if (typeof username !== 'string' || typeof password !== 'string') {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'Username and password must be strings',
    };
    res.status(400).json(error);
    return;
  }

  try {
    const result = await login(username, password);
    res.status(200).json(result);
  } catch {
    // Auth errors are opaque — never reveal which credential was wrong
    const error: ErrorResponse = {
      error: 'INVALID_CREDENTIALS',
      message: 'Authentication failed',
    };
    res.status(401).json(error);
  }
});

/**
 * GET /api/v1/auth/google/config
 * Returns Google OAuth config for the frontend (client ID).
 */
router.get('/google/config', (_req: Request, res: Response): void => {
  res.json({ clientId: config.google.clientId });
});

/**
 * POST /api/v1/auth/google
 * Authenticate with Google OAuth ID token (OIDC).
 * JIT-provisions new users, links existing by email.
 * Returns standard JWT + user profile (same shape as login).
 *
 * Body: { credential: string }  — Google ID token from GIS
 */
router.post('/google', async (req: Request, res: Response): Promise<void> => {
  const { credential } = req.body;

  if (!credential || typeof credential !== 'string') {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Google credential is required' });
    return;
  }

  if (!config.google.clientId) {
    console.error('[auth] GOOGLE_CLIENT_ID not configured');
    res.status(500).json({ error: 'CONFIG_ERROR', message: 'Google authentication is not configured' });
    return;
  }

  try {
    const result = await loginWithGoogle(credential);
    res.status(200).json(result);
  } catch (err: unknown) {
    const statusCode = (err as any).statusCode || 401;
    const message = (err as Error).message || 'Google authentication failed';
    res.status(statusCode).json({ error: 'GOOGLE_AUTH_FAILED', message });
  }
});

/**
 * POST /api/v1/auth/change-password
 * Change authenticated user's password.
 * Requires Bearer token (including reset tokens).
 * This endpoint is NOT subject to forcePasswordResetMiddleware.
 *
 * Body: { currentPassword: string, newPassword: string }
 * Returns: ChangePasswordResult on success
 *   - 401 if current password is wrong
 *   - 400 if new password same as current or too short
 *
 * @see Requirements 1.3, 1.4, 1.9
 */
router.post('/change-password', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { currentPassword, newPassword } = req.body;

  // Validate request body
  if (!currentPassword || !newPassword) {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'currentPassword and newPassword are required',
    };
    res.status(400).json(error);
    return;
  }

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    const error: ErrorResponse = {
      error: 'VALIDATION_ERROR',
      message: 'currentPassword and newPassword must be strings',
    };
    res.status(400).json(error);
    return;
  }

  try {
    const user = req.user!;
    const result = await changePassword(user.sub, currentPassword, newPassword);
    res.status(200).json(result);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; statusCode?: number };

    if (error.statusCode === 401) {
      const errorResponse: ErrorResponse = {
        error: 'INVALID_CREDENTIALS',
        message: 'Authentication failed',
      };
      res.status(401).json(errorResponse);
      return;
    }

    if (error.code === 'PASSWORD_SAME') {
      const errorResponse: ErrorResponse = {
        error: 'PASSWORD_SAME',
        message: error.message,
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (error.code === 'PASSWORD_TOO_SHORT') {
      const errorResponse: ErrorResponse = {
        error: 'PASSWORD_TOO_SHORT',
        message: error.message,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Unexpected error
    const errorResponse: ErrorResponse = {
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

/**
 * GET /api/v1/auth/google-drive/status
 * Check if the authenticated user has authorized Google Drive access.
 */
router.get('/google-drive/status', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  try {
    const authorized = await hasDriveToken(user.sub);
    res.json({ authorized });
  } catch {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to check Drive authorization status' });
  }
});

/**
 * GET /api/v1/auth/google-drive/auth
 * Get the Google OAuth URL for Drive authorization.
 * Redirect the user to this URL in a popup window.
 */
router.get('/google-drive/auth', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  const clientId = config.google.driveClientId || config.google.clientId;
  if (!clientId || !config.google.clientSecret) {
    res.status(500).json({ error: 'CONFIG_ERROR', message: 'Google Drive OAuth is not configured' });
    return;
  }

  // Determine redirect URI from the request
  const redirectUri = `${req.protocol}://${req.get('host')}/api/v1/auth/google-drive/callback`;

  const oauth2Client = new OAuth2Client(clientId, config.google.clientSecret, redirectUri);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/documents.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/presentations.readonly',
    ],
    prompt: 'consent', // Force consent screen every time to ensure refresh_token is returned
    state: signDriveState(user.sub), // signed userId — verified in callback (anti login-CSRF)
  });

  res.json({ authUrl });
});

/**
 * GET /api/v1/auth/google-drive/callback
 * OAuth callback — exchange code for tokens, store refresh_token.
 * Serves a mini-page that posts a message to the opener window and closes.
 */
router.get('/google-drive/callback', async (req: Request, res: Response): Promise<void> => {
  const { code, state } = req.query;

  if (!code || typeof code !== 'string' || !state || typeof state !== 'string') {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Missing authorization code or state' });
    return;
  }

  const userId = verifyDriveState(state);
  if (!userId) {
    res.status(400).json({ error: 'AUTH_ERROR', message: 'Invalid OAuth state — session tidak valid atau berubah' });
    return;
  }

  const clientId = config.google.driveClientId || config.google.clientId;
  if (!clientId || !config.google.clientSecret) {
    res.status(500).json({ error: 'CONFIG_ERROR', message: 'Google Drive OAuth is not configured' });
    return;
  }

  const redirectUri = `${req.protocol}://${req.get('host')}/api/v1/auth/google-drive/callback`;
  const oauth2Client = new OAuth2Client(clientId, config.google.clientSecret, redirectUri);

  try {
    const { tokens } = await oauth2Client.getToken(code as string);

    if (!tokens.refresh_token) {
      // If no refresh_token returned (user already authorized before), retrieve existing
      res.status(400).json({ error: 'AUTH_ERROR', message: 'No refresh token returned. Please revoke access in Google Account and try again.' });
      return;
    }

    // Extract email from id_token if available
    let googleEmail = '';
    if (tokens.id_token) {
      const ticket = await oauth2Client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const payload = ticket.getPayload();
      googleEmail = payload?.email || '';
    }

    await storeRefreshToken(
      userId,
      tokens.refresh_token,
      googleEmail,
      tokens.scope?.split(' ') || [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/documents.readonly',
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/presentations.readonly',
      ],
    );

    // Serve mini-page that notifies the opener and closes
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html><body><script>
  if (window.opener) {
    window.opener.postMessage({ type: 'gd_auth_complete' }, '*');
    window.close();
  } else {
    document.write('Akses Google Drive berhasil. Silakan tutup jendela ini dan kembali ke chat.');
  }
</script></body></html>`);
  } catch (err: unknown) {
    console.error('[google-drive/callback] Token exchange failed:', (err as Error).message);
    res.status(500).json({ error: 'TOKEN_EXCHANGE_FAILED', message: 'Gagal mendapatkan token akses Google Drive' });
  }
});

/**
 * DELETE /api/v1/auth/google-drive/revoke
 * Revoke user's Google Drive access.
 */
router.delete('/google-drive/revoke', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  try {
    await deleteDriveToken(user.sub);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to revoke Drive access' });
  }
});

export default router;
