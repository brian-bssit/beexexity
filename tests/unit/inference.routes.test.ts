import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { inferenceRouter, activeTurns } from '../../src/routes/inference.routes.js';

// Mock dependencies
vi.mock('../../src/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      sub: 'user-123',
      username: 'testuser',
      role: 'user' as const,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    next();
  }),
  apiKeyAuthMiddleware: vi.fn((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      sub: 'user-123',
      username: 'testuser',
      role: 'user' as const,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    next();
  }),
}));

vi.mock('../../src/middleware/password-reset.middleware.js', () => ({
  forcePasswordResetMiddleware: vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next()),
}));

vi.mock('../../src/middleware/security.middleware.js', () => ({
  inferenceRateLimit: vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next()),
}));

vi.mock('../../src/middleware/upload.middleware.js', () => ({
  uploadMiddleware: vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next()),
  multerErrorHandler: vi.fn((_err: Error, _req: express.Request, _res: express.Response, _next: express.NextFunction) => {}),
}));

vi.mock('../../src/config/database.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  tryAcquireSessionLock: vi.fn().mockResolvedValue({ locked: true, release: vi.fn().mockResolvedValue(undefined) }),
  releaseSessionLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/pii-masker.service.js', () => ({
  mask: vi.fn((text: string) => ({
    maskedText: text,
    detectedEntities: [],
    entityCount: 0,
  })),
}));

vi.mock('../../src/services/inference.service.js', () => ({
  validateModelId: vi.fn((modelId?: string) => {
    if (!modelId) return 'qwen.qwen3-32b-v1:0';
    const allowed = [
      'nvidia.nemotron-super-3-120b',
      'openai.gpt-oss-120b-1:0',
      'qwen.qwen3-235b-a22b-2507-v1:0',
      'qwen.qwen3-32b-v1:0',
      'deepseek.v3-v1:0',
    ];
    if (!allowed.includes(modelId)) {
      const error = new Error(`Invalid model. Choose from: ${allowed.join(', ')}`);
      (error as Error & { code: string }).code = 'INVALID_MODEL';
      (error as Error & { statusCode: number }).statusCode = 400;
      throw error;
    }
    return modelId;
  }),
  generate: vi.fn(async (_req: unknown, res: express.Response) => {
    res.write('event: delta\ndata: {"type":"text","content":"Hello"}\n\n');
    res.write('event: metadata\ndata: {"inputTokens":10,"outputTokens":5}\n\n');
    res.write('event: done\ndata: {}\n\n');
    return { status: 'success', inputTokens: 10, outputTokens: 5, modelId: 'qwen.qwen3-32b-v1:0', assistantText: 'Hello' };
  }),
  InferenceError: class InferenceError extends Error {
    category: string;
    statusCode: number;
    constructor(message: string, category: string, statusCode: number) {
      super(message);
      this.name = 'InferenceError';
      this.category = category;
      this.statusCode = statusCode;
    }
  },
}));

vi.mock('../../src/services/audit.service.js', () => ({
  auditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/session-memory.service.js', () => ({
  loadMemoryState: vi.fn().mockResolvedValue({ summary: null, memoryVersion: 0, facts: {} }),
  summarizeEvicted: vi.fn().mockResolvedValue(undefined),
  extractFacts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/session.service.js', () => ({
  getActiveSession: vi.fn().mockResolvedValue(null),
  getSessionMessages: vi.fn().mockResolvedValue([]),
  getOrCreateSession: vi.fn().mockResolvedValue({
    id: 'session-123',
    userId: 'user-123',
    status: 'active',
    turnCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  }),
  getValidatedSession: vi.fn().mockResolvedValue({
    id: 'session-123',
    userId: 'user-123',
    status: 'active',
    turnCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  }),
  storeMessage: vi.fn().mockResolvedValue({
    id: 'msg-123',
    sessionId: 'session-123',
    role: 'user',
    sanitizedContent: 'test',
    createdAt: new Date().toISOString(),
    storageFlags: { piiMasked: true },
  }),
  markSessionInactive: vi.fn().mockResolvedValue(undefined),
  transitionToDegraded: vi.fn().mockResolvedValue(undefined),
  incrementTurnCount: vi.fn().mockResolvedValue(undefined),
  SessionExpiredError: class SessionExpiredError extends Error {
    constructor(sessionId: string) {
      super(`Session ${sessionId} has expired`);
      this.name = 'SessionExpiredError';
    }
  },
  SessionNotFoundError: class SessionNotFoundError extends Error {
    constructor(sessionId: string) {
      super(`Session ${sessionId} not found`);
      this.name = 'SessionNotFoundError';
    }
  },
}));

vi.mock('../../src/services/context-assembly.service.js', () => ({
  buildContext: vi.fn().mockReturnValue({
    inference_payload: [{ role: 'user', content: [{ text: 'Hello world' }] }],
    routing_payload: undefined,
    truncated: false,
    historyMessageCount: 0,
    evictedMessages: [],
  }),
  assembleContext: vi.fn().mockReturnValue({
    messages: [],
    totalEstimatedTokens: 0,
    truncated: false,
    truncatedCount: 0,
    summarized: false,
    originalMessageCount: 0,
  }),
  buildKnowledgeSection: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/services/knowledge.service.js', () => ({
  search: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/services/routing-engine.service.js', () => ({
  routeRequest: vi.fn().mockResolvedValue({
    executedModelId: 'qwen.qwen3-32b-v1:0',
    routingState: 'auto',
    complexityScore: 2,
    scoreBand: 'direct-answer',
    confidence: 0.8,
    refinedPrompt: 'Hello world',
    routingReasonCode: 'simple-query',
    reasoningSummary: 'Simple query detected',
    modalityFlags: { textOnly: true, documentText: false, image: false, mixed: false },
    manualOverrideApplied: false,
    flags: [],
  }),
  getDefaultFormatTemplate: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/services/upload-validator.service.js', () => ({
  validateAndClassifyFiles: vi.fn().mockReturnValue({ documents: [], images: [], fileCount: 0, mimeTypes: [], totalSize: 0 }),
}));

vi.mock('../../src/config/model-capabilities.js', () => ({
  supportsImages: vi.fn().mockReturnValue(true),
  getVisionModels: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/services/document-extractor.service.js', () => ({
  extractDocumentText: vi.fn().mockResolvedValue({ text: '', filename: '' }),
}));

vi.mock('../../src/services/image-processor.service.js', () => ({
  processImages: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/services/content-builder.service.js', () => ({
  buildContentBlocks: vi.fn().mockReturnValue([{ text: 'test' }]),
}));

import { mask } from '../../src/services/pii-masker.service.js';
import { generate, validateModelId, InferenceError } from '../../src/services/inference.service.js';
import { auditService } from '../../src/services/audit.service.js';

/**
 * Helper to send HTTP requests to the test server.
 */
function makeRequest(
  server: http.Server,
  path: string,
  body: unknown,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      return reject(new Error('Server not listening'));
    }
    const postData = JSON.stringify(body);
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: address.port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 500, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/inference', inferenceRouter);
  return app;
}

describe('Inference Routes — POST /api/v1/inference/generate', () => {
  let server: http.Server;
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    activeTurns.clear();
    app = createApp();
    server = app.listen(0); // random port
  });

  afterEach(() => {
    server.close();
  });

  describe('Input Validation', () => {
    it('should return 400 when prompt is missing', async () => {
      const res = await makeRequest(server, '/api/v1/inference/generate', { modelId: 'qwen.qwen3-32b-v1:0' });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('EMPTY_PROMPT');
      expect(body.message).toBe('Prompt cannot be empty');
    });

    it('should return 400 when prompt is empty string', async () => {
      const res = await makeRequest(server, '/api/v1/inference/generate', { prompt: '' });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('EMPTY_PROMPT');
    });

    it('should return 400 when prompt is whitespace only', async () => {
      const res = await makeRequest(server, '/api/v1/inference/generate', { prompt: '   ' });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('EMPTY_PROMPT');
    });

    it('should return 400 for invalid model ID', async () => {
      const res = await makeRequest(server, '/api/v1/inference/generate', { prompt: 'Hello world', modelId: 'invalid-model' });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('INVALID_MODEL');
    });
  });

  describe('SSE Streaming', () => {
    it('should set SSE headers on successful request', async () => {
      const res = await makeRequest(server, '/api/v1/inference/generate', { prompt: 'Hello world' });

      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['connection']).toBe('keep-alive');
    });

    it('should stream delta, metadata, and done events', async () => {
      const res = await makeRequest(server, '/api/v1/inference/generate', { prompt: 'Hello world' });

      expect(res.body).toContain('event: delta');
      expect(res.body).toContain('event: metadata');
      expect(res.body).toContain('event: done');
    });

    it('should default to qwen.qwen3-32b-v1:0 when modelId is not specified', async () => {
      await makeRequest(server, '/api/v1/inference/generate', { prompt: 'Hello world' });

      expect(validateModelId).toHaveBeenCalledWith(undefined, 'user-123');
    });
  });

  describe('PII Masking Integration', () => {
    it('should call the PII masker with the prompt text', async () => {
      await makeRequest(server, '/api/v1/inference/generate', { prompt: 'Transfer to Budi account 1234567890' });

      expect(mask).toHaveBeenCalledWith('Transfer to Budi account 1234567890');
    });
  });

  describe('Audit Logging', () => {
    it('should audit log on successful inference', async () => {
      await makeRequest(server, '/api/v1/inference/generate', { prompt: 'Hello world' });

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          username: 'testuser',
          modelId: 'qwen.qwen3-32b-v1:0',
          inputTokens: 10,
          outputTokens: 5,
          status: 'success',
        }),
      );
    });

    it('should audit log on failed inference with error category', async () => {
      vi.mocked(generate).mockRejectedValueOnce(
        new InferenceError('Model response timed out', 'timeout', 504),
      );

      const res = await makeRequest(server, '/api/v1/inference/generate', { prompt: 'Hello world' });

      // Should send SSE error event
      expect(res.body).toContain('event: error');
      expect(res.body).toContain('TIMEOUT');

      // Should audit log the failure
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          username: 'testuser',
          status: 'failed',
          errorCategory: 'timeout',
        }),
      );
    });
  });

  describe('Error Handling', () => {
    it('should send SSE error event on inference error', async () => {
      vi.mocked(generate).mockRejectedValueOnce(
        new InferenceError('Service temporarily busy', 'throttling', 503),
      );

      const res = await makeRequest(server, '/api/v1/inference/generate', { prompt: 'Hello world' });

      expect(res.body).toContain('event: error');
      expect(res.body).toContain('THROTTLING');
      expect(res.body).toContain('Service temporarily busy');
    });

    it('should handle unknown errors gracefully', async () => {
      vi.mocked(generate).mockRejectedValueOnce(new Error('Something went wrong'));

      const res = await makeRequest(server, '/api/v1/inference/generate', { prompt: 'Hello world' });

      expect(res.body).toContain('event: error');
      expect(res.body).toContain('UNKNOWN');
    });
  });
});
