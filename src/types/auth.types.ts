/**
 * Authentication and user management types.
 * @see Requirements 1.1, 1.2, 1.4, 1.5, 2.1, 2.2, 2.3
 */

export interface LoginResult {
  token?: string;                    // Only present when no reset required
  expiresIn?: number;
  user: UserProfile;
  requiresPasswordReset?: boolean;   // true when First_Login_Flag is set
  resetToken?: string;               // Short-lived token for password change only
}

export interface TokenPayload {
  sub: string;       // user ID (or applicationId for API key auth)
  username: string;
  role: 'admin' | 'user' | 'api_key';
  authProvider?: 'local' | 'google';  // present for Google-authenticated users
  iat: number;
  exp: number;
}

export interface UserProfile {
  id: string;
  username: string;
  role: 'admin' | 'user';
  displayName: string;
  groupName?: string;                // Organizational group
  createdAt: string;
  updatedAt: string;
  forcePasswordReset: boolean;       // Exposed to client
  authProvider: 'local' | 'google';  // Authentication method
}

export interface CreateUserDto {
  username: string;
  password: string;
  role: 'admin' | 'user';
  displayName: string;
  groupName?: string;
}

export interface UpdateUserDto {
  role?: 'admin' | 'user';
  displayName?: string;
  groupName?: string;
  password?: string;
  forcePasswordReset?: boolean;
}

/** Single entry in a bulk user upload request. */
export interface BulkUserEntry {
  username: string;
  displayName: string;
  groupName?: string;
  role: 'admin' | 'user';
  password: string;
  forcePasswordReset: boolean;
}

/** Per-item result from a bulk upload. */
export interface BulkItemResult {
  username: string;
  action: 'created' | 'updated' | 'skipped';
  success: boolean;
  error?: string;
}

/** Response from the bulk upload endpoint. */
export interface BulkUploadResponse {
  total: number;
  successful: number;
  failed: number;
  results: BulkItemResult[];
}

export interface ChangePasswordDto {
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordResult {
  token: string;
  expiresIn: number;
  user: UserProfile;
}
