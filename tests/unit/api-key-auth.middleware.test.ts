import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';

// Mock validateApiKey to control behavior per test
vi.mock('../../src/services/api-key.service.js', () => ({
  validateApiKey: vi.fn(),
}));

import { validateApiKey } from '../../src/services/api-key.service.js';
import { apiKeyAuthMiddleware } from '../../src/middleware/auth.middleware.js';

function mockReqRes() {
  const req = {
    headers: {} as Record<string, string | string[] | undefined>,
    user: undefined,
    apiKeyContext: undefined,
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

const validCtx = {
  apiKeyId: 'key-1',
  applicationId: 'app-1',
  applicationName: 'TestApp',
  billingMode: 'PER_APP' as const,
  username: null,
};

describe('apiKeyAuthMiddleware', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── Scenario 1: Valid key → next() ──────────────────────────
  it('should call next() for a valid API key (PER_APP)', async () => {
    vi.mocked(validateApiKey).mockResolvedValue(validCtx);
    const { req, res, next } = mockReqRes();
    req.headers['x-api-key'] = 'bex_validkey123456789012345678901234';

    await apiKeyAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.apiKeyContext).toEqual(validCtx);
    expect(req.user).toBeDefined();
    expect(req.user!.role).toBe('api_key');
    expect(req.user!.sub).toBe('app-1');
    expect(req.user!.username).toBe('TestApp');
  });

  // ── Scenario 2: Missing header → 401 ────────────────────────
  it('should return 401 MISSING_API_KEY when x-api-key header is missing', async () => {
    vi.mocked(validateApiKey).mockResolvedValue(null);
    const { req, res, next } = mockReqRes();

    await apiKeyAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'MISSING_API_KEY',
      message: 'API key required',
    });
    expect(next).not.toHaveBeenCalled();
  });

  // ── Scenario 3: Empty string header → 401 ───────────────────
  it('should return 401 for empty x-api-key header', async () => {
    const { req, res, next } = mockReqRes();
    req.headers['x-api-key'] = '';

    await apiKeyAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'MISSING_API_KEY' }),
    );
  });

  // ── Scenario 4: Invalid key → 401 ───────────────────────────
  it('should return 401 INVALID_API_KEY when validateApiKey returns null', async () => {
    vi.mocked(validateApiKey).mockResolvedValue(null);
    const { req, res, next } = mockReqRes();
    req.headers['x-api-key'] = 'bex_invalidkey12345678901234567890';

    await apiKeyAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'INVALID_API_KEY',
      message: 'Invalid or deactivated API key',
    });
    expect(next).not.toHaveBeenCalled();
  });

  // ── Scenario 5: PER_USER without x-username → 400 ───────────
  it('should return 400 USERNAME_REQUIRED when PER_USER app has no x-username', async () => {
    vi.mocked(validateApiKey).mockResolvedValue({
      ...validCtx,
      billingMode: 'PER_USER',
    });
    const { req, res, next } = mockReqRes();
    req.headers['x-api-key'] = 'bex_validkey123456789012345678901234';
    // No x-username header

    await apiKeyAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'USERNAME_REQUIRED',
      message: 'x-username header required for this application',
    });
    expect(next).not.toHaveBeenCalled();
  });

  // ── Scenario 6: PER_USER with empty x-username → 400 ────────
  it('should return 400 USERNAME_REQUIRED when x-username is empty string', async () => {
    vi.mocked(validateApiKey).mockResolvedValue({
      ...validCtx,
      billingMode: 'PER_USER',
    });
    const { req, res, next } = mockReqRes();
    req.headers['x-api-key'] = 'bex_validkey123456789012345678901234';
    req.headers['x-username'] = '   '; // whitespace only

    await apiKeyAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'USERNAME_REQUIRED' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  // ── Scenario 7: PER_USER with valid x-username → next() ─────
  it('should call next() for PER_USER with valid x-username header', async () => {
    vi.mocked(validateApiKey).mockResolvedValue({
      ...validCtx,
      billingMode: 'PER_USER',
    });
    const { req, res, next } = mockReqRes();
    req.headers['x-api-key'] = 'bex_validkey123456789012345678901234';
    req.headers['x-username'] = 'user@corp.com';

    await apiKeyAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.apiKeyContext!.username).toBe('user@corp.com');
    expect(req.user!.role).toBe('api_key');
  });

  // ── Scenario 8: DB error → 500 ──────────────────────────────
  it('should return 500 INTERNAL_ERROR when DB query fails', async () => {
    vi.mocked(validateApiKey).mockRejectedValue(new Error('DB connection lost'));
    const { req, res, next } = mockReqRes();
    req.headers['x-api-key'] = 'bex_anykey123456789012345678901234';

    await apiKeyAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'INTERNAL_ERROR',
      message: 'Authentication service unavailable',
    });
  });
});
