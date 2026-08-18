import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.routes.js';
import adminRoutes from './routes/admin.routes.js';
import modelsRoutes from './routes/models.routes.js';
import { inferenceRouter } from './routes/inference.routes.js';
import { sessionRouter } from './routes/session.routes.js';
import feedbackRoutes from './routes/feedback.routes.js';
import generationRoutes from './routes/generation.routes.js';
import { knowledgeRouter } from './routes/knowledge.routes.js';
import adminApplicationsRoutes from './routes/admin-applications.routes.js';
import { ErrorResponse } from './types/error.types.js';
import { securityHeaders, apiRateLimit } from './middleware/security.middleware.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Express application setup with middleware stack and route mounting.
 * @see Requirements 6.5, 7.5
 */
const app = express();

// --- Security ---
app.disable('x-powered-by');
app.set('trust proxy', 1); // trust first proxy for correct IP in rate limiting

// --- Middleware Stack ---
app.use(securityHeaders);
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));
app.use(express.json({ limit: '10mb' })); // limit body size to prevent abuse
app.use(apiRateLimit);

// --- Health Check (database connectivity test) ---
app.get('/api/v1/health', async (_req, res) => {
  try {
    const { pool } = await import('./config/database.js');
    const dbResult = await pool.query('SELECT 1 AS ok');
    res.json({
      status: 'healthy',
      database: dbResult.rows[0]?.ok === 1 ? 'connected' : 'unexpected',
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/v1/config/passthrough
 * Public endpoint — returns whether passthrough mode is globally active.
 * Used by the chat UI to show a read-only badge.
 */
app.get('/api/v1/config/passthrough', async (_req, res) => {
  try {
    const { configService } = await import('./services/config.service.js');
    const enabled = await configService.getPassthroughMode();
    res.json({ enabled });
  } catch {
    res.json({ enabled: false });
  }
});

// --- Static Frontend ---
app.use(express.static(join(__dirname, '..', 'public'), {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Expires', '0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Surrogate-Control', 'no-store');
    } else if (path.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
    } else if (path.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    } else if (path.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
  },
}));

// --- Route Mounting ---
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/admin', adminApplicationsRoutes);
app.use('/api/v1/models', modelsRoutes);
app.use('/api/v1/inference', inferenceRouter);
app.use('/api/v1/sessions', sessionRouter);
app.use('/api/v1/feedback', feedbackRoutes);
app.use('/api/v1/generate', generationRoutes);
app.use('/api/v1/knowledge', knowledgeRouter);

// --- Global Error Handler ---
// Catches unhandled errors and returns a sanitized response.
// Internal details are logged server-side but never exposed to the client.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  // Log the actual error internally for debugging
  console.error('[Unhandled Error]', err);

  const errorResponse: ErrorResponse = {
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
  };

  res.status(500).json(errorResponse);
});

export default app;
