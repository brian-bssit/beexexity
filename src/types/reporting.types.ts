/**
 * Reporting types — per-user cost aggregation from audit_logs.
 * Used by the admin cost-reporting endpoint.
 */

/** Per-model breakdown within a user's aggregate row. */
export interface UserModelBreakdown {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  /** null when model_pricing_snapshot was unavailable for this row. */
  estimatedCostUsd: number | null;
}

/** Per-user aggregate cost row. */
export interface UserCostReport {
  userId: string;
  username: string;
  displayName: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  /** null when any model row lacked a pricing snapshot. */
  estimatedCostUsd: number | null;
  breakdown: UserModelBreakdown[];
  // Multi-tenant API key tracking (nullable — only populated for API key requests)
  applicationId?: string | null;
  applicationName?: string | null;
  apiKeyId?: string | null;
  keyPrefix?: string | null;
}

/** Paginated response for the cost-reporting endpoint. */
export interface CostReportResponse {
  users: UserCostReport[];
  grandTotal: {
    totalInputTokens: number;
    totalOutputTokens: number;
    requestCount: number;
    /** null when any model row across all users lacked a pricing snapshot. */
    estimatedCostUsd: number | null;
  };
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Raw DB row shape from the per-user GROUP BY query. */
export interface CostReportAuditRow {
  user_id: string;
  username: string;
  display_name: string;
  model_id: string;
  input_tokens: string;
  output_tokens: string;
  request_count: string;
  model_pricing_snapshot: Record<string, number> | null;
  // Multi-tenant API key fields
  application_id?: string | null;
  application_name?: string | null;
  api_key_id?: string | null;
  key_prefix?: string | null;
}
