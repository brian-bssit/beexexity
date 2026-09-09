import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock OAuth2Client before importing
const mockGetAccessToken = vi.fn();
vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    setCredentials: vi.fn(),
    getAccessToken: mockGetAccessToken,
  })),
}));

vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/config/database.js';
import {
  getValidAccessToken,
  storeRefreshToken,
  hasDriveToken,
  deleteDriveToken,
  clearTokenCache,
  GoogleDriveNotAuthorizedError,
  GoogleDriveTokenRevokedError,
} from '../../src/services/google-drive-token.service.js';

const mockQuery = vi.mocked(query);

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
});

describe('hasDriveToken', () => {
  it('returns true when token exists', async () => {
    mockQuery.mockResolvedValue({ rows: [{ 1: 1 }] } as any);
    expect(await hasDriveToken('user-1')).toBe(true);
  });

  it('returns false when no token', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any);
    expect(await hasDriveToken('user-1')).toBe(false);
  });
});

describe('getValidAccessToken', () => {
  const tokenRow = {
    id: 't1',
    refresh_token: 'rt1',
    google_email: 'u@example.com',
    granted_scopes: ['drive.readonly'],
    last_refreshed_at: null,
  };

  it('returns cached token if valid', async () => {
    // Prime cache by calling once
    mockQuery.mockResolvedValue({ rows: [tokenRow] } as any);
    mockGetAccessToken.mockResolvedValue({ token: 'access1' });
    await getValidAccessToken('user-1');
    vi.clearAllMocks();

    // Second call should use cache, no DB query
    const token = await getValidAccessToken('user-1');
    expect(token).toBe('access1');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refreshes and caches token when not in cache', async () => {
    mockQuery.mockResolvedValue({ rows: [tokenRow] } as any);
    mockGetAccessToken.mockResolvedValue({ token: 'access1' });

    const token = await getValidAccessToken('user-1');
    expect(token).toBe('access1');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SELECT'),
      ['user-1'],
    );
  });

  it('throws GoogleDriveNotAuthorizedError when no token in DB', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any);
    await expect(getValidAccessToken('no-user')).rejects.toThrow(GoogleDriveNotAuthorizedError);
  });

  it('throws GoogleDriveTokenRevokedError on invalid_grant', async () => {
    mockQuery.mockResolvedValue({ rows: [tokenRow] } as any);
    mockGetAccessToken.mockRejectedValue(new Error('invalid_grant: token revoked'));
    await expect(getValidAccessToken('user-1')).rejects.toThrow(GoogleDriveTokenRevokedError);
  });

  it('throws GoogleDriveTokenRevokedError on revoked message', async () => {
    mockQuery.mockResolvedValue({ rows: [tokenRow] } as any);
    mockGetAccessToken.mockRejectedValue(new Error('Token has been revoked'));
    await expect(getValidAccessToken('user-1')).rejects.toThrow(GoogleDriveTokenRevokedError);
  });

  it('re-throws unknown errors', async () => {
    mockQuery.mockResolvedValue({ rows: [tokenRow] } as any);
    mockGetAccessToken.mockRejectedValue(new Error('network error'));
    await expect(getValidAccessToken('user-1')).rejects.toThrow('network error');
  });
});

describe('storeRefreshToken', () => {
  it('inserts token with upsert', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any);
    await storeRefreshToken('user-1', 'rt1', 'u@example.com', ['drive.readonly']);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_google_drive_tokens'),
      ['user-1', 'rt1', 'u@example.com', ['drive.readonly']],
    );
  });

  it('invalidates cache on store', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any);
    // Prime cache
    mockQuery.mockResolvedValue({ rows: [{ id: 't1', refresh_token: 'old', google_email: '', granted_scopes: [], last_refreshed_at: null }] } as any);
    mockGetAccessToken.mockResolvedValue({ token: 'cached' });
    await getValidAccessToken('user-1');
    // Store new token
    mockQuery.mockResolvedValue({ rows: [] } as any);
    await storeRefreshToken('user-1', 'rt2', 'u@example.com', ['drive.readonly']);
    // Next getValidAccessToken should refresh
    mockQuery.mockResolvedValue({ rows: [{ id: 't1', refresh_token: 'rt2', google_email: '', granted_scopes: [], last_refreshed_at: null }] } as any);
    mockGetAccessToken.mockResolvedValue({ token: 'fresh' });
    const token = await getValidAccessToken('user-1');
    expect(token).toBe('fresh');
  });
});

describe('deleteDriveToken', () => {
  it('deletes token and clears cache', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any);
    await deleteDriveToken('user-1');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE'),
      ['user-1'],
    );
  });
});
