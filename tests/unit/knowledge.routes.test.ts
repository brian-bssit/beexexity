import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('../../src/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next()),
  apiKeyAuthMiddleware: vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next()),
}));

vi.mock('../../src/middleware/upload.middleware.js', () => ({
  knowledgeUploadMiddleware: vi.fn((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { file: unknown }).file = {
      originalname: 'SOP_Test.md',
      mimetype: 'text/markdown',
      buffer: Buffer.from('# Isi SOP'),
      size: 12,
    };
    next();
  }),
  multerErrorHandler: vi.fn((_e: Error, _r: express.Request, _s: express.Response, _n: express.NextFunction) => {}),
}));

vi.mock('../../src/config/database.js', () => ({ query: vi.fn() }));

vi.mock('../../src/services/document-extractor.service.js', () => ({
  extractDocumentText: vi.fn().mockResolvedValue({ text: 'extracted content' }),
}));

vi.mock('../../src/services/knowledge.service.js', () => ({
  indexDocument: vi.fn().mockResolvedValue({ id: 'chunk-1', chunkIndex: 1 }),
}));

import { knowledgeRouter } from '../../src/routes/knowledge.routes.js';
import { query } from '../../src/config/database.js';

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;

const app = express();
app.use(express.json());
app.use('/api/v1/knowledge', knowledgeRouter);

async function request(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { status: res.status, data };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/knowledge/documents', () => {
  it('accepts a valid upload and returns 202 Accepted', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ id: 'job-1' }] });

    const { status, data } = await request('POST', '/api/v1/knowledge/documents', {
      metadata: JSON.stringify({ title: 'SOP Test', doc_type: 'SOP', binding_level: 'regulatory' }),
    });

    expect(status).toBe(202);
    expect(data).toEqual({ id: 'job-1', status: 'processing' });
  });

  it('rejects upload missing doc_type', async () => {
    const { status, data } = await request('POST', '/api/v1/knowledge/documents', {
      metadata: JSON.stringify({ title: 'No type' }),
    });

    expect(status).toBe(400);
    expect(data.error).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed metadata JSON', async () => {
    const { status } = await request('POST', '/api/v1/knowledge/documents', { metadata: 'not json{' });

    expect(status).toBe(400);
  });

  it('marks the job completed after async ingestion', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ id: 'job-1' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // UPDATE completed

    const { status } = await request('POST', '/api/v1/knowledge/documents', {
      metadata: JSON.stringify({ title: 'SOP Test', doc_type: 'SOP' }),
    });

    expect(status).toBe(202);
    await vi.waitFor(() => {
      expect(mockedQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'completed'"), [1, 'job-1']);
    });
  });
});

describe('GET /api/v1/knowledge/documents/:id/status', () => {
  it('returns the ingestion job status', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ id: 'job-1', source_file: 'SOP_Test.md', status: 'completed', chunks_indexed: 1, error: null }],
    });

    const { status, data } = await request('GET', '/api/v1/knowledge/documents/job-1/status');

    expect(status).toBe(200);
    expect(data.status).toBe('completed');
    expect(data.chunks_indexed).toBe(1);
  });

  it('404s on unknown job id', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] });

    const { status } = await request('GET', '/api/v1/knowledge/documents/missing/status');

    expect(status).toBe(404);
  });
});

describe('GET /api/v1/knowledge/documents', () => {
  it('lists recent ingestion jobs', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ id: 'job-1', source_file: 'a.md', status: 'completed', chunks_indexed: 1, error: null }],
    });

    const { status, data } = await request('GET', '/api/v1/knowledge/documents?limit=10');

    expect(status).toBe(200);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].status).toBe('completed');
  });
});
