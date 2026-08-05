import { Router, Request, Response } from 'express';
import { login, loginWithGoogle, changePassword } from '../services/auth.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { config } from '../config/index.js';
import { ErrorResponse } from '../types/error.types.js';
import { loginRateLimit } from '../middleware/security.middleware.js';

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

export default router;
