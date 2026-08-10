import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditEntry } from '../../src/types/audit.types.js';

// Mock the database module
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/config/database.js';
import { auditService } from '../../src/services/audit.service.js';

const mockedQuery = vi.mocked(query);

describe('AuditService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validEntry: AuditEntry = {
    timestamp: '2024-01-15T10:30:00.000Z',
    userId: '550e8400-e29b-41d4-a716-446655440000',
    username: 'testuser',
    modelId: 'qwen.qwen3-32b-v1:0',
    inputTokens: 42,
    outputTokens: 156,
    status: 'success',
    durationMs: 1200,
  };

  describe('log()', () => {
    it('should insert an audit record into audit_logs table', async () => {
      mockedQuery.mockResolvedValueOnce({} as any);

      await auditService.log(validEntry);

      expect(mockedQuery).toHaveBeenCalledOnce();
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_logs'),
        [
          validEntry.timestamp,
          validEntry.userId,
          validEntry.username,
          validEntry.modelId,
          validEntry.inputTokens,
          validEntry.outputTokens,
          validEntry.status,
          null, // errorCategory is undefined → null
          validEntry.durationMs,
          null, // fileCount is undefined → null
          null, // fileMimeTypes is undefined → null
          null, // totalFileSize is undefined → null
          false, // isMultimodal is undefined → false
          null, // routingState is undefined → null
          null, // complexityScore is undefined → null
          null, // routingReasonCode is undefined → null
          null, // reasoningSummary is undefined → null
          null, // executedModelId is undefined → null
          false, // manualOverrideApplied is undefined → false
          null, // modalityFlags is undefined → null
          null, // routingFlags is undefined → null
          null, // sessionId is undefined → null
          null, // replayedMessageCount is undefined → null
          false, // contextTruncated is undefined → false
          false, // contextSummarized is undefined → false
          null, // sessionState is undefined → null
          null, // turnCount is undefined → null
          JSON.stringify({ inputPricePer1MTokens: 0.16, outputPricePer1MTokens: 0.62 }), // modelPricingSnapshot for qwen3-32b
          null, // orchestrationMeta is undefined → null
          null, // orchestrationGroupId is undefined → null
          null, // orchestrationStepOrder is undefined → null
          null, // routingContext
          null, // routingIntent
          null, // sessionContext
          null, // billedUserId
          null, // billedGroup
          false, // apiKeyUsed
          null, // apiKeyId
          null, // applicationId
          false, // passthrough
          null, // knowledgeSourceIds (not provided → null)
        ],
      );
    });

    it('should record error category for failed requests', async () => {
      mockedQuery.mockResolvedValueOnce({} as any);

      const failedEntry: AuditEntry = {
        ...validEntry,
        status: 'failed',
        errorCategory: 'throttling',
      };

      await auditService.log(failedEntry);

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_logs'),
        expect.arrayContaining(['throttling']),
      );
    });

    it('should record timeout error category', async () => {
      mockedQuery.mockResolvedValueOnce({} as any);

      const timeoutEntry: AuditEntry = {
        ...validEntry,
        status: 'failed',
        errorCategory: 'timeout',
      };

      await auditService.log(timeoutEntry);

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_logs'),
        expect.arrayContaining(['timeout']),
      );
    });

    it('should record model_error category', async () => {
      mockedQuery.mockResolvedValueOnce({} as any);

      const modelErrorEntry: AuditEntry = {
        ...validEntry,
        status: 'failed',
        errorCategory: 'model_error',
      };

      await auditService.log(modelErrorEntry);

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_logs'),
        expect.arrayContaining(['model_error']),
      );
    });

    it('should not throw when DB insert fails (graceful degradation)', async () => {
      mockedQuery.mockRejectedValueOnce(new Error('Connection refused'));

      // Should not throw
      await expect(auditService.log(validEntry)).resolves.toBeUndefined();
    });

    it('should log error to console when DB insert fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dbError = new Error('Connection timeout');
      mockedQuery.mockRejectedValueOnce(dbError);

      await auditService.log(validEntry);

      expect(consoleSpy).toHaveBeenCalledWith(
        '[AuditService] Failed to persist audit log entry:',
        dbError,
      );

      consoleSpy.mockRestore();
    });

    it('should never store prompt text or response text', async () => {
      mockedQuery.mockResolvedValueOnce({} as any);

      await auditService.log(validEntry);

      // Verify the SQL query doesn't include any prompt/response columns
      const sqlQuery = mockedQuery.mock.calls[0][0] as string;
      expect(sqlQuery).not.toContain('prompt');
      expect(sqlQuery).not.toContain('response');

      // Verify the params array only contains the expected metadata fields
      const params = mockedQuery.mock.calls[0][1] as unknown[];
      expect(params).toHaveLength(41);
      expect(params).toEqual([
        validEntry.timestamp,
        validEntry.userId,
        validEntry.username,
        validEntry.modelId,
        validEntry.inputTokens,
        validEntry.outputTokens,
        validEntry.status,
        null,
        validEntry.durationMs,
        null,
        null,
        null,
        false,
        null, // routingState
        null, // complexityScore
        null, // routingReasonCode
        null, // reasoningSummary
        null, // executedModelId
        false, // manualOverrideApplied
        null, // modalityFlags
        null, // routingFlags
        null, // sessionId
        null, // replayedMessageCount
        false, // contextTruncated
        false, // contextSummarized
        null, // sessionState
        null, // turnCount
        JSON.stringify({ inputPricePer1MTokens: 0.16, outputPricePer1MTokens: 0.62 }), // modelPricingSnapshot
          null, // orchestrationMeta is undefined → null
        null, // orchestrationGroupId
        null, // orchestrationStepOrder
        null, // routingContext
        null, // routingIntent
        null, // sessionContext
        null, // billedUserId
        null, // billedGroup
        false, // apiKeyUsed
        null, // apiKeyId
        null, // applicationId
        false, // passthrough
        null, // knowledgeSourceIds (not provided → null)
      ]);
    });

    it('should pass null for errorCategory when not provided', async () => {
      mockedQuery.mockResolvedValueOnce({} as any);

      await auditService.log(validEntry);

      const params = mockedQuery.mock.calls[0][1] as unknown[];
      // errorCategory is at index 7
      expect(params[7]).toBeNull();
    });

    it('should persist session metadata fields when provided', async () => {
      mockedQuery.mockResolvedValueOnce({} as any);

      const entryWithSession: AuditEntry = {
        ...validEntry,
        sessionId: '660e8400-e29b-41d4-a716-446655440001',
        replayedMessageCount: 5,
        contextTruncated: true,
        contextSummarized: false,
        sessionState: 'active',
        turnCount: 3,
      };

      await auditService.log(entryWithSession);

      const params = mockedQuery.mock.calls[0][1] as unknown[];
      // Session fields are at indices 13-16
      expect(params[21]).toBe('660e8400-e29b-41d4-a716-446655440001'); // sessionId
      expect(params[22]).toBe(5); // replayedMessageCount
      expect(params[23]).toBe(true); // contextTruncated
      expect(params[24]).toBe(false); // contextSummarized
      // Session continuity fields at indices 17-18
      expect(params[25]).toBe('active'); // sessionState
      expect(params[26]).toBe(3); // turnCount
      // Pricing snapshot at index 19 (from actual pricing-config.json)
      expect(params[27]).toBe(JSON.stringify({ inputPricePer1MTokens: 0.16, outputPricePer1MTokens: 0.62 }));
    });

    it('should not include any raw message content in audit fields', async () => {
      mockedQuery.mockResolvedValueOnce({} as any);

      const entryWithSession: AuditEntry = {
        ...validEntry,
        sessionId: '660e8400-e29b-41d4-a716-446655440001',
        replayedMessageCount: 3,
        contextTruncated: false,
        contextSummarized: false,
      };

      await auditService.log(entryWithSession);

      // Verify the SQL only includes metadata columns, not content
      const sqlQuery = mockedQuery.mock.calls[0][0] as string;
      expect(sqlQuery).not.toContain('content');
      expect(sqlQuery).not.toContain('message_text');
      expect(sqlQuery).toContain('session_id');
      expect(sqlQuery).toContain('replayed_message_count');
      expect(sqlQuery).toContain('context_truncated');
      expect(sqlQuery).toContain('context_summarized');
      expect(sqlQuery).toContain('session_state');
      expect(sqlQuery).toContain('turn_count');

      // Verify params contain only IDs, counts, and booleans — no strings that could be content
      const params = mockedQuery.mock.calls[0][1] as unknown[];
      // sessionId is a UUID string, not content
      expect(typeof params[21]).toBe('string');
      expect((params[21] as string).match(/^[0-9a-f-]+$/)).toBeTruthy();
      // replayedMessageCount is a number
      expect(typeof params[22]).toBe('number');
      // contextTruncated and contextSummarized are booleans
      expect(typeof params[23]).toBe('boolean');
      expect(typeof params[24]).toBe('boolean');
      // sessionState is null (not provided), turnCount is null (not provided)
      expect(params[25]).toBeNull();
      expect(params[26]).toBeNull();
      // modelPricingSnapshot (from actual pricing-config.json for qwen3-32b)
      expect(params[27]).toBe(JSON.stringify({ inputPricePer1MTokens: 0.16, outputPricePer1MTokens: 0.62 }));
    });
  });
});
