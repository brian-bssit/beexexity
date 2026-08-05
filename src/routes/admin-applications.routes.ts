/**
 * Admin routes — Application & API Key management.
 * All endpoints restricted to admin role via authMiddleware → adminMiddleware.
 * @see docs/feature-multi-tenant-api-key/
 */

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { forcePasswordResetMiddleware } from '../middleware/password-reset.middleware.js';
import { adminMiddleware } from '../middleware/admin.middleware.js';
import {
  createApplication,
  listApplications,
  getApplication,
  updateApplication,
  deleteApplication,
} from '../services/application.service.js';
import {
  generateApiKey,
  listKeysByApplication,
  deactivateKey,
  deleteKey,
} from '../services/api-key.service.js';

const router = Router();

// Apply auth + admin guard to all routes
router.use(authMiddleware);
router.use(forcePasswordResetMiddleware);
router.use(adminMiddleware);

// ── Applications ─────────────────────────────────────────────────

/** GET /api/v1/admin/applications — List all applications */
router.get('/applications', async (_req: Request, res: Response) => {
  try {
    const apps = await listApplications();
    res.json({ applications: apps });
  } catch (err: unknown) {
    console.error('[admin] listApplications failed:', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list applications' });
  }
});

/** POST /api/v1/admin/applications — Create a new application */
router.post('/applications', async (req: Request, res: Response) => {
  try {
    const { name, billingMode, createdBy } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'Application name is required' });
      return;
    }
    if (billingMode && !['PER_APP', 'PER_USER'].includes(billingMode)) {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'billingMode must be PER_APP or PER_USER' });
      return;
    }
    const app = await createApplication(name.trim(), billingMode || 'PER_APP', createdBy);
    res.status(201).json(app);
  } catch (err: unknown) {
    const msg = (err as Error).message;
    if (msg.includes('unique') || msg.includes('duplicate')) {
      res.status(409).json({ error: 'DUPLICATE_NAME', message: 'Application name already exists' });
      return;
    }
    console.error('[admin] createApplication failed:', msg);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create application' });
  }
});

/** GET /api/v1/admin/applications/:id — Get application by ID */
router.get('/applications/:id', async (req: Request, res: Response) => {
  try {
    const app = await getApplication(req.params.id as string);
    if (!app) {
      res.status(404).json({ error: 'APPLICATION_NOT_FOUND', message: 'Application not found' });
      return;
    }
    res.json(app);
  } catch (err: unknown) {
    console.error('[admin] getApplication failed:', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get application' });
  }
});

/** PUT /api/v1/admin/applications/:id — Update application */
router.put('/applications/:id', async (req: Request, res: Response) => {
  try {
    const { name, billingMode, isActive } = req.body;
    if (billingMode && !['PER_APP', 'PER_USER'].includes(billingMode)) {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'billingMode must be PER_APP or PER_USER' });
      return;
    }
    const app = await updateApplication(req.params.id as string, {
      name: name?.trim(),
      billingMode,
      isActive: isActive !== undefined ? Boolean(isActive) : undefined,
    });
    res.json(app);
  } catch (err: unknown) {
    const e = err as Error & { status?: number };
    if (e.status === 404) {
      res.status(404).json({ error: 'APPLICATION_NOT_FOUND', message: 'Application not found' });
      return;
    }
    console.error('[admin] updateApplication failed:', e.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update application' });
  }
});

/** DELETE /api/v1/admin/applications/:id — Delete application (CASCADE keys) */
router.delete('/applications/:id', async (req: Request, res: Response) => {
  try {
    await deleteApplication(req.params.id as string);
    res.status(204).send();
  } catch (err: unknown) {
    const e = err as Error & { status?: number };
    if (e.status === 404) {
      res.status(404).json({ error: 'APPLICATION_NOT_FOUND', message: 'Application not found' });
      return;
    }
    console.error('[admin] deleteApplication failed:', e.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete application' });
  }
});

// ── API Keys ─────────────────────────────────────────────────────

/** GET /api/v1/admin/applications/:id/keys — List keys for application */
router.get('/applications/:id/keys', async (req: Request, res: Response) => {
  try {
    const keys = await listKeysByApplication(req.params.id as string);
    res.json({ keys });
  } catch (err: unknown) {
    console.error('[admin] listKeys failed:', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list API keys' });
  }
});

/** POST /api/v1/admin/applications/:id/keys — Generate new API key */
router.post('/applications/:id/keys', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'Key name is required' });
      return;
    }
    // Verify application exists
    const app = await getApplication(req.params.id as string);
    if (!app) {
      res.status(404).json({ error: 'APPLICATION_NOT_FOUND', message: 'Application not found' });
      return;
    }
    const result = await generateApiKey(req.params.id as string, name.trim());
    res.status(201).json(result);
  } catch (err: unknown) {
    console.error('[admin] generateApiKey failed:', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to generate API key' });
  }
});

/** PUT /api/v1/admin/keys/:id — Deactivate API key */
router.put('/keys/:id', async (req: Request, res: Response) => {
  try {
    await deactivateKey(req.params.id as string);
    res.json({ status: 'deactivated' });
  } catch (err: unknown) {
    const e = err as Error & { status?: number };
    if (e.status === 404) {
      res.status(404).json({ error: 'KEY_NOT_FOUND', message: 'API key not found' });
      return;
    }
    console.error('[admin] deactivateKey failed:', e.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to deactivate API key' });
  }
});

/** DELETE /api/v1/admin/keys/:id — Permanently delete API key */
router.delete('/keys/:id', async (req: Request, res: Response) => {
  try {
    await deleteKey(req.params.id as string);
    res.status(204).send();
  } catch (err: unknown) {
    const e = err as Error & { status?: number };
    if (e.status === 404) {
      res.status(404).json({ error: 'KEY_NOT_FOUND', message: 'API key not found' });
      return;
    }
    console.error('[admin] deleteKey failed:', e.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete API key' });
  }
});

export default router;
