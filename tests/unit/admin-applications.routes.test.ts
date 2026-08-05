import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router, Request, Response } from 'express';

// Mock services
vi.mock('../../src/services/application.service.js', () => ({
  createApplication: vi.fn(),
  listApplications: vi.fn(),
  getApplication: vi.fn(),
  updateApplication: vi.fn(),
  deleteApplication: vi.fn(),
}));

vi.mock('../../src/services/api-key.service.js', () => ({
  generateApiKey: vi.fn(),
  listKeysByApplication: vi.fn(),
  deactivateKey: vi.fn(),
  deleteKey: vi.fn(),
}));

import {
  createApplication,
  listApplications,
  getApplication,
  deleteApplication,
} from '../../src/services/application.service.js';
import { generateApiKey, deactivateKey, deleteKey } from '../../src/services/api-key.service.js';

// We'll test the route handlers directly by extracting them from the router
let router: Router;

const mockApp = {
  id: 'app-1', name: 'TestApp', billing_mode: 'PER_APP' as const,
  created_by: 'admin', is_active: true,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  key_count: 2,
};

function mockReq(method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string>) {
  return {
    method, path, body: body || {},
    params: { id: path.split('/').pop() || '' },
    query: query || {},
    user: { sub: 'admin-id', username: 'admin', role: 'admin' as const, iat: 1, exp: 999999999 },
    apiKeyContext: undefined,
  } as unknown as Request;
}

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe('admin-applications routes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Dynamic import to get fresh router with mocked deps
    const mod = await import('../../src/routes/admin-applications.routes.js');
    router = mod.default;
  });

  function getHandler(method: string, routePath: string): Function {
    const layer = router.stack.find(
      (l: { route?: { path: string; methods: Record<string, boolean> } }) =>
        l.route?.path === routePath && l.route?.methods[method.toLowerCase()]
    );
    if (!layer) throw new Error(`No handler for ${method} ${routePath}`);
    // Skip middleware layers (authMiddleware etc.), get the last handler
    const handlers = layer.route!.stack.map((s: { handle: Function }) => s.handle);
    return handlers[handlers.length - 1];
  }

  describe('GET /applications', () => {
    it('should return list of applications', async () => {
      vi.mocked(listApplications).mockResolvedValueOnce([mockApp]);
      const handler = getHandler('get', '/applications');
      const res = mockRes();

      await handler(mockReq('GET', '/applications'), res);

      expect(res.json).toHaveBeenCalledWith({ applications: [mockApp] });
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(listApplications).mockRejectedValueOnce(new Error('DB down'));
      const handler = getHandler('get', '/applications');
      const res = mockRes();

      await handler(mockReq('GET', '/applications'), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('POST /applications', () => {
    it('should create and return 201', async () => {
      vi.mocked(createApplication).mockResolvedValueOnce(mockApp);
      const handler = getHandler('post', '/applications');
      const res = mockRes();
      const req = mockReq('POST', '/applications', { name: 'TestApp', billingMode: 'PER_APP' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(mockApp);
    });

    it('should return 400 if name is missing', async () => {
      const handler = getHandler('post', '/applications');
      const res = mockRes();
      const req = mockReq('POST', '/applications', {});

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('DELETE /applications/:id', () => {
    it('should delete and return 204', async () => {
      vi.mocked(deleteApplication).mockResolvedValueOnce(undefined);
      const handler = getHandler('delete', '/applications/:id');
      const res = mockRes();

      await handler(mockReq('DELETE', '/applications/app-1'), res);

      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('should return 404 for non-existent app', async () => {
      vi.mocked(deleteApplication).mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));
      const handler = getHandler('delete', '/applications/:id');
      const res = mockRes();

      await handler(mockReq('DELETE', '/applications/nonexistent'), res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /applications/:id/keys', () => {
    it('should generate key and return 201', async () => {
      vi.mocked(getApplication).mockResolvedValueOnce(mockApp);
      vi.mocked(generateApiKey).mockResolvedValueOnce({ id: 'key-1', key: 'bex_test123', prefix: 'bex_', name: 'test' });
      const handler = getHandler('post', '/applications/:id/keys');
      const res = mockRes();

      await handler(mockReq('POST', '/applications/app-1/keys', { name: 'test' }), res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 400 if key name is missing', async () => {
      const handler = getHandler('post', '/applications/:id/keys');
      const res = mockRes();

      await handler(mockReq('POST', '/applications/app-1/keys', {}), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('PUT /keys/:id', () => {
    it('should deactivate key', async () => {
      vi.mocked(deactivateKey).mockResolvedValueOnce(undefined);
      const handler = getHandler('put', '/keys/:id');
      const res = mockRes();

      await handler(mockReq('PUT', '/keys/key-1'), res);

      expect(res.json).toHaveBeenCalledWith({ status: 'deactivated' });
    });
  });

  describe('DELETE /keys/:id', () => {
    it('should delete key and return 204', async () => {
      vi.mocked(deleteKey).mockResolvedValueOnce(undefined);
      const handler = getHandler('delete', '/keys/:id');
      const res = mockRes();

      await handler(mockReq('DELETE', '/keys/key-1'), res);

      expect(res.status).toHaveBeenCalledWith(204);
    });
  });
});
