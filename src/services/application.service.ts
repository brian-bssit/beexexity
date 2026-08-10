/**
 * Application Service — CRUD operations for registered consuming applications.
 * Admin-only access enforced by route-level middleware (authMiddleware → adminMiddleware).
 * @see docs/features/multi-tenant-api-key/
 */

import { query } from '../config/database.js';
import type { Application } from '../types/api-key.types.js';

interface ApplicationRow {
  id: string;
  name: string;
  billing_mode: 'PER_APP' | 'PER_USER';
  created_by: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  key_count?: string; // COUNT() from JOIN — parsed to number
}

function mapRow(row: ApplicationRow): Application {
  return {
    id: row.id,
    name: row.name,
    billing_mode: row.billing_mode,
    created_by: row.created_by,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    key_count: row.key_count ? parseInt(row.key_count, 10) : undefined,
  };
}

/** Create a new application. Name must be unique. */
export async function createApplication(
  name: string,
  billingMode: 'PER_APP' | 'PER_USER',
  createdBy?: string,
): Promise<Application> {
  const { rows } = await query<ApplicationRow>(
    `INSERT INTO applications (name, billing_mode, created_by)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [name, billingMode, createdBy || null],
  );
  return mapRow(rows[0]!);
}

/** List all applications, newest first. Includes key count. */
export async function listApplications(): Promise<Application[]> {
  const { rows } = await query<ApplicationRow>(
    `SELECT a.*, COUNT(k.id)::integer AS key_count
     FROM applications a
     LEFT JOIN api_keys k ON k.application_id = a.id
     GROUP BY a.id
     ORDER BY a.created_at DESC`,
  );
  return rows.map(mapRow);
}

/** Get a single application by ID, or null if not found. */
export async function getApplication(id: string): Promise<Application | null> {
  const { rows } = await query<ApplicationRow>(
    `SELECT a.*, COUNT(k.id)::integer AS key_count
     FROM applications a
     LEFT JOIN api_keys k ON k.application_id = a.id
     WHERE a.id = $1
     GROUP BY a.id`,
    [id],
  );
  if (!rows[0]) return null;
  return mapRow(rows[0]);
}

/** Update application fields. Only provided fields are changed. */
export async function updateApplication(
  id: string,
  updates: { name?: string; billingMode?: 'PER_APP' | 'PER_USER'; isActive?: boolean },
): Promise<Application> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 0;

  if (updates.name !== undefined) {
    paramIdx++;
    sets.push(`name = $${paramIdx}`);
    params.push(updates.name);
  }
  if (updates.billingMode !== undefined) {
    paramIdx++;
    sets.push(`billing_mode = $${paramIdx}`);
    params.push(updates.billingMode);
  }
  if (updates.isActive !== undefined) {
    paramIdx++;
    sets.push(`is_active = $${paramIdx}`);
    params.push(updates.isActive);
  }

  if (sets.length === 0) {
    // Nothing to update — return current state
    const app = await getApplication(id);
    if (!app) throw Object.assign(new Error('Application not found'), { status: 404 });
    return app;
  }

  paramIdx++;
  sets.push(`updated_at = NOW()`);
  params.push(id);

  const { rows } = await query<ApplicationRow>(
    `UPDATE applications SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    params,
  );
  if (!rows[0]) {
    throw Object.assign(new Error('Application not found'), { status: 404 });
  }
  return mapRow(rows[0]);
}

/** Delete an application. API keys CASCADE. Audit logs preserved (FK SET NULL). */
export async function deleteApplication(id: string): Promise<void> {
  const result = await query('DELETE FROM applications WHERE id = $1', [id]);
  if (result.rowCount === 0) {
    throw Object.assign(new Error('Application not found'), { status: 404 });
  }
}
