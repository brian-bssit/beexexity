import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

// Mock database
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/config/database.js';
import {
  generateApiKey,
  listKeysByApplication,
  deactivateKey,
  deleteKey,
  validateApiKey,
} from '../../src/services/api-key.service.js';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('generateApiKey', () => {
  it('should generate a key with "bex_" prefix and 36 total chars', async () => {
    const mockId = '550e8400-e29b-41d4-a716-446655440000';
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ id: mockId, application_id: 'app-1', name: 'test-key', key_prefix: 'bex_12345678abcd', key_hash: 'hash', is_active: true, last_used_at: null, created_at: new Date().toISOString() }],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
    });

    const result = await generateApiKey('app-1', 'test-key');

    expect(result.key).toMatch(/^bex_[a-f0-9]{32}$/);
    expect(result.key).toHaveLength(36);
    expect(result.prefix).toBe(result.key.substring(0, 16));
    expect(result.id).toBe(mockId);
    expect(result.name).toBe('test-key');
  });

  it('should store SHA-256 hash in DB, not the raw key', async () => {
    let capturedHash = '';
    vi.mocked(query).mockImplementationOnce((async (_sql: string, params?: unknown[]) => {
      const hash = params?.[3] as string;
      capturedHash = hash;
      return {
        rows: [{ id: 'id', application_id: 'app-1', name: 'k', key_prefix: 'pfx', key_hash: hash, is_active: true, last_used_at: null, created_at: new Date().toISOString() }],
        rowCount: 1, command: 'INSERT', oid: 0, fields: [],
      };
    }) as unknown as typeof query);

    const result = await generateApiKey('app-1', 'test-key');
    const expectedHash = sha256(result.key);

    expect(capturedHash).toBe(expectedHash);
    expect(capturedHash).not.toBe(result.key); // never store raw key
  });
});

describe('listKeysByApplication', () => {
  it('should return keys for the given application', async () => {
    const rows = [
      { id: 'k1', application_id: 'app-1', name: 'key1', key_prefix: 'bex_a1b2', key_hash: 'h1', is_active: true, last_used_at: null, created_at: '2026-01-01T00:00:00Z' },
      { id: 'k2', application_id: 'app-1', name: 'key2', key_prefix: 'bex_c3d4', key_hash: 'h2', is_active: false, last_used_at: '2026-06-01T00:00:00Z', created_at: '2026-01-02T00:00:00Z' },
    ];
    vi.mocked(query).mockResolvedValueOnce({ rows, rowCount: 2, command: 'SELECT', oid: 0, fields: [] });

    const keys = await listKeysByApplication('app-1');

    expect(keys).toHaveLength(2);
    expect(keys[0].key_prefix).toBe('bex_a1b2');
    expect(keys[1].is_active).toBe(false);
  });

  it('should return empty array for application with no keys', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

    const keys = await listKeysByApplication('nonexistent');
    expect(keys).toHaveLength(0);
  });
});

describe('deactivateKey', () => {
  it('should set is_active = false', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] });
    await expect(deactivateKey('key-1')).resolves.toBeUndefined();
  });

  it('should throw 404 for non-existent key', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] });
    await expect(deactivateKey('nonexistent')).rejects.toMatchObject({ message: 'API key not found' });
  });
});

describe('deleteKey', () => {
  it('should permanently delete the key', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 1, command: 'DELETE', oid: 0, fields: [] });
    await expect(deleteKey('key-1')).resolves.toBeUndefined();
  });

  it('should throw 404 for non-existent key', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'DELETE', oid: 0, fields: [] });
    await expect(deleteKey('nonexistent')).rejects.toMatchObject({ message: 'API key not found' });
  });
});

describe('validateApiKey', () => {
  it('should return ApiKeyContext for valid key with active app', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{
        id: 'key-1', application_id: 'app-1', is_active: true,
        app_name: 'TestApp', billing_mode: 'PER_APP' as const, app_is_active: true,
      }],
      rowCount: 1, command: 'SELECT', oid: 0, fields: [],
    });
    // Second query: UPDATE last_used_at (fire-and-forget)
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] });

    const ctx = await validateApiKey('bex_validkey123456789012345678901234');

    expect(ctx).not.toBeNull();
    expect(ctx!.apiKeyId).toBe('key-1');
    expect(ctx!.applicationId).toBe('app-1');
    expect(ctx!.applicationName).toBe('TestApp');
    expect(ctx!.billingMode).toBe('PER_APP');
    expect(ctx!.username).toBeNull();
  });

  it('should return null for invalid key (hash mismatch)', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

    const ctx = await validateApiKey('bex_invalid');

    expect(ctx).toBeNull();
  });

  it('should return null when key is inactive', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ id: 'key-1', application_id: 'app-1', is_active: false, app_name: 'TestApp', billing_mode: 'PER_APP', app_is_active: true }],
      rowCount: 1, command: 'SELECT', oid: 0, fields: [],
    });

    const ctx = await validateApiKey('bex_disabledkey12345678901234567890');

    expect(ctx).toBeNull();
  });

  it('should return null when application is inactive', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ id: 'key-1', application_id: 'app-1', is_active: true, app_name: 'TestApp', billing_mode: 'PER_APP', app_is_active: false }],
      rowCount: 1, command: 'SELECT', oid: 0, fields: [],
    });

    const ctx = await validateApiKey('bex_validkey123456789012345678901234');

    expect(ctx).toBeNull();
  });

  it('should update last_used_at on successful validation', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ id: 'key-1', application_id: 'app-1', is_active: true, app_name: 'TestApp', billing_mode: 'PER_APP', app_is_active: true }],
      rowCount: 1, command: 'SELECT', oid: 0, fields: [],
    });
    let updateCalled = false;
    vi.mocked(query).mockImplementationOnce((async () => {
      updateCalled = true;
      return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
    }) as unknown as typeof query);

    await validateApiKey('bex_validkey123456789012345678901234');

    expect(updateCalled).toBe(true);
  });
});
