import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { verifyToken } from '../services/auth.service.js';
import { TokenPayload } from '../types/auth.types.js';
import { config } from '../config/index.js';

/**
 * Extend Express Request to include the decoded user payload.
 */
declare module 'express' {
  interface Request {
    user?: TokenPayload;
  }
}

/**
 * Auth middleware — validates JWT on protected routes.
 * Extracts Bearer token from the Authorization header, verifies signature and expiry,
 * and attaches the decoded TokenPayload to req.user.
 *
 * Returns 401 with a descriptive message for:
 * - Missing Authorization header
 * - Malformed Authorization header (not Bearer scheme)
 * - Expired tokens
 * - Tampered/invalid signature tokens
 *
 * @see Requirements 1.4, 1.5
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      error: 'MISSING_TOKEN',
      message: 'Authorization header is required',
    });
    return;
  }

  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'INVALID_TOKEN_FORMAT',
      message: 'Authorization header must use Bearer scheme',
    });
    return;
  }

  const token = authHeader.slice(7); // Remove 'Bearer ' prefix

  if (!token) {
    res.status(401).json({
      error: 'MISSING_TOKEN',
      message: 'Token is required after Bearer scheme',
    });
    return;
  }

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    res.status(401).json({
      error: 'INVALID_TOKEN',
      message,
    });
  }
}

/**
 * API Key authentication middleware for machine-to-machine calls.
 * Validates X-API-Key header via constant-time comparison.
 * Resolves to a "ghostmeet" system user for audit attribution.
 *
 * Used by the batch inference endpoint (GhostMeet → beexexity).
 */
export function apiKeyAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || typeof apiKey !== 'string' || apiKey.length === 0) {
    res.status(401).json({
      error: 'MISSING_API_KEY',
      message: 'X-API-Key header is required',
    });
    return;
  }

  const configuredKey = config.auth.apiKey;
  if (!configuredKey) {
    console.error('[api-key-auth] GHOSTMEET_API_KEY not configured');
    res.status(500).json({
      error: 'CONFIGURATION_ERROR',
      message: 'API key authentication is not configured',
    });
    return;
  }

  const keyBuffer = Buffer.from(apiKey);
  const expectedBuffer = Buffer.from(configuredKey);

  if (keyBuffer.length !== expectedBuffer.length || !timingSafeEqual(keyBuffer, expectedBuffer)) {
    res.status(401).json({
      error: 'INVALID_API_KEY',
      message: 'Invalid API key',
    });
    return;
  }

  // Resolve to ghostmeet system user for audit attribution
  const now = Math.floor(Date.now() / 1000);
  req.user = {
    sub: '00000000-0000-0000-0000-000000000000', // ghostmeet system user
    username: 'ghostmeet',
    role: 'user',
    iat: now,
    exp: now + 3600,
  };

  next();
}

/**
 * Maps JWT verification errors to descriptive user-facing messages.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TokenExpiredError') {
      return 'Token has expired';
    }
    if (error.name === 'JsonWebTokenError') {
      return 'Token is invalid or has been tampered with';
    }
    if (error.name === 'NotBeforeError') {
      return 'Token is not yet active';
    }
  }
  return 'Token invalid or expired';
}
