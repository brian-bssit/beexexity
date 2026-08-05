import { describe, it, expect, vi } from 'vitest';

// Mock database
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/config/database.js';
import {
  createApplication,
  listApplications,
  getApplication,
  updateApplication,
  deleteApplication,
} from '../../src/services/application.service.js';

function mockApp(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id as string ?? 'app-1',
    name: overrides.name as string ?? 'TestApp',
    billing_mode: overrides.billing_mode as 'PER_APP' | 'PER_USER' ?? 'PER_APP',
    created_by: overrides.created_by as string | null ?? null,
    is_active: overrides.is_active as boolean ?? true,
    created_at: overrides.created_at as string ?? '2026-01-01T00:00:00Z',
    updated_at: overrides.updated_at as string ?? '2026-01-01T00:00:00Z',
    key_count: overrides.key_count as string | undefined,
  };
}

describe('createApplication', () => {
  it('should create an application with default PER_APP billing', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [mockApp()], rowCount: 1, command: 'INSERT', oid: 0, fields: [],
    });

    const app = await createApplication('TestApp', 'PER_APP');

    expect(app.name).toBe('TestApp');
    expect(app.billing_mode).toBe('PER_APP');
    expect(app.is_active).toBe(true);
  });

  it('should create with PER_USER billing mode', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [mockApp({ billing_mode: 'PER_USER', created_by: 'admin@corp.com' })], rowCount: 1, command: 'INSERT', oid: 0, fields: [],
    });

    const app = await createApplication('UserApp', 'PER_USER', 'admin@corp.com');

    expect(app.billing_mode).toBe('PER_USER');
    expect(app.created_by).toBe('admin@corp.com');
  });
});

describe('listApplications', () => {
  it('should return all applications with key counts', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [
        mockApp({ id: 'app-1', name: 'App1', key_count: '3' }),
        mockApp({ id: 'app-2', name: 'App2', key_count: '0' }),
      ],
      rowCount: 2, command: 'SELECT', oid: 0, fields: [],
    });

    const apps = await listApplications();

    expect(apps).toHaveLength(2);
    expect(apps[0].key_count).toBe(3);
    expect(apps[1].key_count).toBe(0);
  });

  it('should return empty array when no applications exist', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

    const apps = await listApplications();
    expect(apps).toHaveLength(0);
  });
});

describe('getApplication', () => {
  it('should return an application by ID', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [mockApp({ id: 'app-1', key_count: '5' })], rowCount: 1, command: 'SELECT', oid: 0, fields: [],
    });

    const app = await getApplication('app-1');

    expect(app).not.toBeNull();
    expect(app!.id).toBe('app-1');
    expect(app!.key_count).toBe(5);
  });

  it('should return null for non-existent ID', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

    const app = await getApplication('nonexistent');
    expect(app).toBeNull();
  });
});

describe('updateApplication', () => {
  it('should update name', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [mockApp({ name: 'RenamedApp' })], rowCount: 1, command: 'UPDATE', oid: 0, fields: [],
    });

    const app = await updateApplication('app-1', { name: 'RenamedApp' });

    expect(app.name).toBe('RenamedApp');
  });

  it('should update billing_mode', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [mockApp({ billing_mode: 'PER_USER' })], rowCount: 1, command: 'UPDATE', oid: 0, fields: [],
    });

    const app = await updateApplication('app-1', { billingMode: 'PER_USER' });

    expect(app.billing_mode).toBe('PER_USER');
  });

  it('should deactivate by setting isActive false', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [mockApp({ is_active: false })], rowCount: 1, command: 'UPDATE', oid: 0, fields: [],
    });

    const app = await updateApplication('app-1', { isActive: false });

    expect(app.is_active).toBe(false);
  });

  it('should throw 404 for non-existent ID', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] });

    await expect(updateApplication('nonexistent', { name: 'X' }))
      .rejects.toMatchObject({ message: 'Application not found' });
  });
});

describe('deleteApplication', () => {
  it('should delete the application (CASCADE keys)', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 1, command: 'DELETE', oid: 0, fields: [] });

    await expect(deleteApplication('app-1')).resolves.toBeUndefined();
  });

  it('should throw 404 for non-existent ID', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'DELETE', oid: 0, fields: [] });

    await expect(deleteApplication('nonexistent'))
      .rejects.toMatchObject({ message: 'Application not found' });
  });
});
