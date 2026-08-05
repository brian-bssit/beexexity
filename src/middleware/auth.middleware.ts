import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.service.js';
import { validateApiKey } from '../services/api-key.service.js';
import { TokenPayload } from '../types/auth.types.js';
import type { ApiKeyContext } from '../types/api-key.types.js';

/**
 * Extend Express Request to include the decoded user payload and API key context.
 */
declare module 'express' {
  interface Request {
    user?: TokenPayload;
    apiKeyContext?: ApiKeyContext;
  }
}

/**
 * Auth middleware — validates JWT on protected routes.
 * Extracts Bearer token from the Authorization header, verifies signature and expiry,
 * and attaches the decoded TokenPayload to req.user.
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

  const token = authHeader.slice(7);

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
 * Validates x-api-key header via database lookup with SHA-256 hashing.
 * Resolves to the application identity for audit attribution.
 *
 * Enforces billing_mode:
 * - PER_USER: requires x-username header (rejects if missing/empty)
 * - PER_APP:  ignores x-username, sets username to null
 */
export async function apiKeyAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || typeof apiKey !== 'string' || apiKey.length === 0) {
    res.status(401).json({
      error: 'MISSING_API_KEY',
      message: 'API key required',
    });
    return;
  }

  try {
    const ctx = await validateApiKey(apiKey);

    if (!ctx) {
      res.status(401).json({
        error: 'INVALID_API_KEY',
        message: 'Invalid or deactivated API key',
      });
      return;
    }

    // Enforce billing mode
    if (ctx.billingMode === 'PER_USER') {
      const username = req.headers['x-username'];
      if (!username || typeof username !== 'string' || username.trim().length === 0) {
        res.status(400).json({
          error: 'USERNAME_REQUIRED',
          message: 'x-username header required for this application',
        });
        return;
      }
      ctx.username = username.trim();
    }
    // PER_APP: ctx.username stays null (as set by validateApiKey)

    // Attach context to request
    req.apiKeyContext = ctx;

    // Populate req.user with application-derived identity
    const now = Math.floor(Date.now() / 1000);
    req.user = {
      sub: ctx.applicationId,
      username: ctx.applicationName,
      role: 'api_key',
      iat: now,
      exp: now + 3600,
    };

    next();
  } catch {
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Authentication service unavailable',
    });
  }
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
