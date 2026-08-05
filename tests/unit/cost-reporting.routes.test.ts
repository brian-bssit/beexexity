import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';

// Mock middlewares to pass through
vi.mock('../../src/middleware/auth.middleware.js', () => ({
  authMiddleware: (_req: Request, _res: Response, next: () => void) => next(),
}));
vi.mock('../../src/middleware/password-reset.middleware.js', () => ({
  forcePasswordResetMiddleware: (_req: Request, _res: Response, next: () => void) => next(),
}));
vi.mock('../../src/middleware/admin.middleware.js', () => ({
  adminMiddleware: (_req: Request, _res: Response, next: () => void) => next(),
}));

vi.mock('../../src/services/cost-reporting.service.js', () => ({
  getCostReport: vi.fn(),
}));

import { default as adminRouter } from '../../src/routes/admin.routes.js';
import { getCostReport } from '../../src/services/cost-reporting.service.js';

const mockGetCostReport = vi.mocked(getCostReport);

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
  };
}

function getCostReportHandler() {
  const stack = (adminRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find(
    (l) => l.route?.path === '/usage/cost' && l.route?.methods?.get,
  );
  if (!layer?.route) throw new Error('GET /usage/cost route not found');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createMockRes() {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as Response;
}

function createMockReq(query: Record<string, string | undefined>): Request {
  return { query } as unknown as Request;
}

const mockReport = {
  users: [
    {
      userId: 'u1',
      username: 'alice',
      displayName: 'Alice',
      totalInputTokens: 100,
      totalOutputTokens: 50,
      requestCount: 3,
      estimatedCostUsd: 0.000047,
      breakdown: [],
    },
  ],
  grandTotal: {
    totalInputTokens: 100,
    totalOutputTokens: 50,
    requestCount: 3,
    estimatedCostUsd: 0.000047,
  },
  total: 1,
  page: 1,
  pageSize: 20,
  hasMore: false,
};

describe('GET /api/v1/admin/usage/cost', () => {
  let handler: (req: Request, res: Response) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = getCostReportHandler();
  });

  it('returns 200 with cost report', async () => {
    mockGetCostReport.mockResolvedValue(mockReport);

    const req = createMockReq({});
    const res = createMockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(mockReport);
  });

  it('returns 400 for invalid from date', async () => {
    const req = createMockReq({ from: 'not-a-date' });
    const res = createMockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'VALIDATION_ERROR' }),
    );
  });

  it('returns 400 for invalid to date', async () => {
    const req = createMockReq({ to: 'not-a-date' });
    const res = createMockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'VALIDATION_ERROR' }),
    );
  });

  it('passes pagination defaults when not provided', async () => {
    mockGetCostReport.mockResolvedValue(mockReport);

    const req = createMockReq({});
    const res = createMockRes();
    await handler(req, res);

    expect(mockGetCostReport).toHaveBeenCalledWith(undefined, undefined, 1, 20, undefined, undefined, undefined);
  });

  it('clamps pageSize to max 100', async () => {
    mockGetCostReport.mockResolvedValue({ ...mockReport, pageSize: 100 });

    const req = createMockReq({ pageSize: '999' });
    const res = createMockRes();
    await handler(req, res);

    expect(mockGetCostReport).toHaveBeenCalledWith(undefined, undefined, 1, 100, undefined, undefined, undefined);
  });

  it('clamps page to min 1', async () => {
    mockGetCostReport.mockResolvedValue(mockReport);

    const req = createMockReq({ page: '0' });
    const res = createMockRes();
    await handler(req, res);

    expect(mockGetCostReport).toHaveBeenCalledWith(undefined, undefined, 1, 20, undefined, undefined, undefined);
  });

  it('returns 500 on service error', async () => {
    mockGetCostReport.mockRejectedValue(new Error('DB failure'));

    const req = createMockReq({});
    const res = createMockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'INTERNAL_ERROR' }),
    );
  });

  it('passes through from/to date filters', async () => {
    mockGetCostReport.mockResolvedValue(mockReport);

    const req = createMockReq({ from: '2026-06-01', to: '2026-06-30' });
    const res = createMockRes();
    await handler(req, res);

    expect(mockGetCostReport).toHaveBeenCalledWith('2026-06-01', '2026-06-30', 1, 20, undefined, undefined, undefined);
  });
});
