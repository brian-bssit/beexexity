import { query } from '../config/database.js';
import type {
  CostReportResponse,
  CostReportAuditRow,
  UserCostReport,
  UserModelBreakdown,
} from '../types/reporting.types.js';

/**
 * Cost Reporting Service — aggregates per-user token usage and estimated cost
 * from successful audit_log entries. Cost is calculated from per-request
 * pricing snapshots stored at inference time.
 */

/**
 * Get a paginated per-user cost report, optionally filtered by date range
 * and multi-tenant API key dimensions.
 *
 * @param from  ISO date string for earliest timestamp (inclusive), or undefined for no lower bound
 * @param to    ISO date string for latest date (inclusive — the entire day is included),
 *              or undefined for no upper bound
 * @param page  Page number (1-based, default 1)
 * @param pageSize  Items per page (default 20, max 100)
 * @param applicationId  Optional filter by application UUID
 * @param apiKeyId  Optional filter by API key UUID
 * @param username  Optional filter by tracking username (x-username header)
 */
export async function getCostReport(
  from?: string,
  to?: string,
  page: number = 1,
  pageSize: number = 20,
  applicationId?: string,
  apiKeyId?: string,
  username?: string,
): Promise<CostReportResponse> {
  const offset = (page - 1) * pageSize;

  // 1. Count distinct users matching the filter
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT al.user_id)::integer AS count
     FROM audit_logs al
     WHERE al.status = 'success'
       AND ($1::timestamptz IS NULL OR al.timestamp >= $1)
       AND ($2::timestamptz IS NULL OR al.timestamp < $2::timestamptz + INTERVAL '1 day')
       AND ($3::uuid IS NULL OR al.application_id = $3)
       AND ($4::uuid IS NULL OR al.api_key_id = $4)
       AND ($5::varchar IS NULL OR al.username = $5)`,
    [from || null, to || null, applicationId || null, apiKeyId || null, username || null],
  );
  const total = parseInt(countResult.rows[0].count, 10);

  if (total === 0) {
    return emptyResponse(page, pageSize);
  }

  // 2. Fetch paginated, grouped data via CTE
  const result = await query<CostReportAuditRow>(
    `WITH filtered_users AS (
       SELECT DISTINCT al.user_id
       FROM audit_logs al
       WHERE al.status = 'success'
         AND ($1::timestamptz IS NULL OR al.timestamp >= $1)
         AND ($2::timestamptz IS NULL OR al.timestamp < $2::timestamptz + INTERVAL '1 day')
         AND ($5::uuid IS NULL OR al.application_id = $5)
         AND ($6::uuid IS NULL OR al.api_key_id = $6)
         AND ($7::varchar IS NULL OR al.username = $7)
       ORDER BY al.user_id
       LIMIT $3 OFFSET $4
     )
     SELECT
       al.user_id,
       al.username,
       u.display_name,
       al.model_id,
       SUM(al.input_tokens)::bigint  AS input_tokens,
       SUM(al.output_tokens)::bigint AS output_tokens,
       COUNT(*)::integer              AS request_count,
       al.model_pricing_snapshot,
       al.application_id,
       app.name AS application_name,
       al.api_key_id,
       k.key_prefix
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     LEFT JOIN applications app ON app.id = al.application_id
     LEFT JOIN api_keys k ON k.id = al.api_key_id
     WHERE al.user_id IN (SELECT fu.user_id FROM filtered_users fu)
       AND al.status = 'success'
       AND ($1::timestamptz IS NULL OR al.timestamp >= $1)
       AND ($2::timestamptz IS NULL OR al.timestamp < $2::timestamptz + INTERVAL '1 day')
     GROUP BY al.user_id, al.username, u.display_name, al.model_id, al.model_pricing_snapshot,
              al.application_id, app.name, al.api_key_id, k.key_prefix
     ORDER BY al.user_id, al.model_id`,
    [from || null, to || null, pageSize, offset, applicationId || null, apiKeyId || null, username || null],
  );

  // 3. Assemble into user aggregates in JS (same pattern as getSessionStats)
  const userMap = new Map<string, UserCostReport>();
  let grandTotalInput = 0;
  let grandTotalOutput = 0;
  let grandTotalRequests = 0;
  let grandTotalCost: number | null = 0;

  for (const row of result.rows) {
    const inputTokens = parseInt(row.input_tokens, 10);
    const outputTokens = parseInt(row.output_tokens, 10);
    const requestCount = parseInt(row.request_count, 10);
    const snapshot = row.model_pricing_snapshot;

    let modelCost: number | null = null;
    if (
      snapshot &&
      typeof snapshot.inputPricePer1MTokens === 'number' &&
      typeof snapshot.outputPricePer1MTokens === 'number'
    ) {
      modelCost =
        (inputTokens * snapshot.inputPricePer1MTokens +
          outputTokens * snapshot.outputPricePer1MTokens) /
        1_000_000;
    }

    const modelBreakdown: UserModelBreakdown = {
      modelId: row.model_id,
      inputTokens,
      outputTokens,
      requestCount,
      estimatedCostUsd: modelCost,
    };

    let userReport = userMap.get(row.user_id);
    if (!userReport) {
      userReport = {
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        requestCount: 0,
        estimatedCostUsd: 0,
        breakdown: [],
        applicationId: row.application_id ?? null,
        applicationName: row.application_name ?? null,
        apiKeyId: row.api_key_id ?? null,
        keyPrefix: row.key_prefix ?? null,
      };
      userMap.set(row.user_id, userReport);
    }

    userReport.totalInputTokens += inputTokens;
    userReport.totalOutputTokens += outputTokens;
    userReport.requestCount += requestCount;
    userReport.breakdown.push(modelBreakdown);

    // If any model row lacks pricing, user total becomes unknown
    if (userReport.estimatedCostUsd !== null) {
      if (modelCost !== null) {
        userReport.estimatedCostUsd += modelCost;
      } else {
        userReport.estimatedCostUsd = null;
      }
    }

    // Grand total
    grandTotalInput += inputTokens;
    grandTotalOutput += outputTokens;
    grandTotalRequests += requestCount;
    if (grandTotalCost !== null) {
      if (modelCost !== null) {
        grandTotalCost += modelCost;
      } else {
        grandTotalCost = null;
      }
    }
  }

  return {
    users: Array.from(userMap.values()),
    grandTotal: {
      totalInputTokens: grandTotalInput,
      totalOutputTokens: grandTotalOutput,
      requestCount: grandTotalRequests,
      estimatedCostUsd: grandTotalCost,
    },
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
}

function emptyResponse(page: number, pageSize: number): CostReportResponse {
  return {
    users: [],
    grandTotal: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      requestCount: 0,
      estimatedCostUsd: null,
    },
    total: 0,
    page,
    pageSize,
    hasMore: false,
  };
}
