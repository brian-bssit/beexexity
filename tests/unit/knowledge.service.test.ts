import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  const mockSend = vi.fn();
  return {
    BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
    InvokeModelCommand: vi.fn().mockImplementation((input) => input),
    __mockSend: mockSend,
  };
});

import { config } from '../../src/config/index.js';
import { query } from '../../src/config/database.js';
import {
  search,
  indexDocument,
  getIngestedDocuments,
  updateDocumentMetadata,
  deleteDocumentBySourceFile,
} from '../../src/services/knowledge.service.js';

const { __mockSend: mockSend } = await import('@aws-sdk/client-bedrock-runtime') as any;

const DIMS = 1536;

function mockEmbedding(): void {
  mockSend.mockResolvedValue({
    body: new Uint8Array(Buffer.from(JSON.stringify({ embeddings: { float: [Array.from({ length: DIMS }, () => 0.1)] } }))),
  });
}

const CHUNK_ROW = {
  id: 'c1',
  content: 'isi dokumen',
  title: 'SOP Pengajuan Kredit',
  doc_type: 'SOP',
  binding_level: 'regulatory',
  source_type: 'internal',
  metadata: {},
  score: 0.82,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('search', () => {
  it('returns semantic matches via pgvector cosine', async () => {
    mockEmbedding();
    vi.mocked(query).mockResolvedValueOnce({ rows: [CHUNK_ROW] });

    const results = await search('prosedur kredit', 3);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'c1',
      title: 'SOP Pengajuan Kredit',
      docType: 'SOP',
      bindingLevel: 'regulatory',
      sourceType: 'internal',
      score: 0.82,
    });
  });

  it('returns [] when every semantic score is below minRelevanceScore (out-of-domain)', async () => {
    mockEmbedding();
    // Cosine returns weak matches (e.g. "siapa presiden Indonesia saat ini" → 0.26).
    // No keyword fallback runs — weak semantic means "not covered by the KB", which
    // is the signal sovereign routing needs to escalate to Tier 3.
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ ...CHUNK_ROW, score: 0.26 }] });

    const results = await search('siapa presiden Indonesia saat ini', 5);

    expect(results).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1); // one semantic query, no keyword fallback
  });

  it('keeps semantic chunks that clear the minRelevanceScore gate', async () => {
    mockEmbedding();
    const gate = config.knowledge.minRelevanceScore;
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ ...CHUNK_ROW, score: gate }] });

    const results = await search('prosedur pengembangan TI', 5);

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('SOP Pengajuan Kredit');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully to [] on DB error', async () => {
    mockEmbedding();
    vi.mocked(query).mockRejectedValueOnce(new Error('db down'));

    const results = await search('apa saja', 3);
    expect(results).toEqual([]);
  });
});

describe('indexDocument', () => {
  /** Bedrock mock: echoes one embedding per requested text (handles batching). */
  function mockEmbeddingApi(): void {
    mockSend.mockImplementation(async (input: { body: string }) => {
      const n = JSON.parse(input.body).texts.length;
      return {
        body: new Uint8Array(Buffer.from(JSON.stringify({
          embeddings: { float: Array.from({ length: n }, () => Array.from({ length: DIMS }, () => 0.1)) },
        }))),
      };
    });
  }

  it('chunks, embeds, dedups, and inserts', async () => {
    mockEmbeddingApi();
    vi.mocked(query)
      // bulk dedup — none exists
      .mockResolvedValueOnce({ rows: [] })
      // insert — returns id
      .mockResolvedValueOnce({ rows: [{ id: 'new-id' }] });

    const result = await indexDocument({
      content: 'dokumen pendek',
      docType: 'MEMO',
      title: 'Memo Test',
      sourceFile: 'memo-test.pdf',
      bindingLevel: 'regulatory',
    });

    expect(result.id).toBe('new-id');
    expect(result.chunkIndex).toBe(1);

    const dedupSql = vi.mocked(query).mock.calls[0]![0] as string;
    expect(dedupSql).toMatch(/content_hash = ANY\(\$1::text\[\]\)/);
  });

  it('skips duplicate chunks by content hash (no embed call)', async () => {
    vi.mocked(query).mockImplementation(async (_sql: string, params: unknown[]) => {
      // every requested hash already exists → all chunks deduped
      return { rows: (params[0] as string[]).map((content_hash) => ({ content_hash })) };
    });

    const result = await indexDocument({
      content: 'konten yang sama persis',
      docType: 'MEMO',
      title: 'Dup',
      sourceFile: 'dup.pdf',
    });

    expect(result.chunkIndex).toBe(0); // nothing inserted
    expect(mockSend).not.toHaveBeenCalled(); // no embedding for dupes
  });

  it('splits long content into multiple chunks and batches the embedding', async () => {
    const longContent = `${'kalimat. '.repeat(1200)}`; // ~9.6K chars → multiple chunks

    mockEmbeddingApi();
    let insertCount = 0;
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('content_hash = ANY')) {
        return { rows: [] }; // dedup miss — no duplicates
      }
      insertCount++;
      return { rows: [{ id: `chunk-${insertCount}` }] };
    });

    const result = await indexDocument({
      content: longContent,
      docType: 'SOP',
      title: 'Panjang',
      sourceFile: 'long.pdf',
    });

    expect(result.chunkIndex).toBeGreaterThan(1); // split into several chunks
    expect(result.id).toBe('chunk-1');
  });
});

describe('getIngestedDocuments', () => {
  const DOC_ROW = {
    source_file: 'sop-kredit.pdf',
    title: 'SOP Pengajuan Kredit',
    version: '2.0',
    doc_type: 'SOP',
    binding_level: 'procedural',
    sensitivity: 'internal',
    source_type: 'internal',
    chunk_count: 3,
    created_at: '2026-01-01T00:00:00Z',
  };

  it('groups chunks by source_file and returns documents + total', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ total: '2' }] }) // COUNT → bigint string
      .mockResolvedValueOnce({ rows: [DOC_ROW] });

    const result = await getIngestedDocuments({}, 50, 0);

    expect(result.total).toBe(2);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      sourceFile: 'sop-kredit.pdf',
      title: 'SOP Pengajuan Kredit',
      version: '2.0',
      docType: 'SOP',
      bindingLevel: 'procedural',
      sensitivity: 'internal',
      sourceType: 'internal',
      chunkCount: 3,
    });

    const listSql = vi.mocked(query).mock.calls[1]![0] as string;
    expect(listSql).toMatch(/GROUP BY source_file/);
    expect(listSql).toMatch(/LIMIT \$1 OFFSET \$2/);
  });

  it('builds ILIKE search + exact-match filters and reuses them in COUNT', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    await getIngestedDocuments(
      { search: 'kredit', docType: 'SOP', bindingLevel: 'procedural' },
      25,
      10,
    );

    const countSql = vi.mocked(query).mock.calls[0]![0] as string;
    const countParams = vi.mocked(query).mock.calls[0]![1] as unknown[];
    expect(countSql).toMatch(/\(title ILIKE \$1 OR source_file ILIKE \$1\)/);
    expect(countSql).toMatch(/doc_type = \$2/);
    expect(countSql).toMatch(/binding_level = \$3/);
    expect(countParams).toEqual(['%kredit%', 'SOP', 'procedural']);

    const listSql = vi.mocked(query).mock.calls[1]![0] as string;
    expect(listSql).toMatch(/LIMIT \$4 OFFSET \$5/);
  });

  it('returns version null as-is when unset (no COALESCE default)', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [{ ...DOC_ROW, version: null }] });

    const result = await getIngestedDocuments({}, 50, 0);
    expect(result.documents[0]!.version).toBeNull();
    const listSql = vi.mocked(query).mock.calls[1]![0] as string;
    expect(listSql).not.toMatch(/COALESCE\(.*version/);
  });
});

describe('updateDocumentMetadata', () => {
  const UPDATE_SQL = 'UPDATE knowledge_documents';

  it('cascades a full update across all chunks of source_file', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 2 });

    const n = await updateDocumentMetadata('sop.pdf', {
      title: 'Judul Baru',
      version: '2.0',
      docType: 'SOP',
      bindingLevel: 'regulatory',
      sensitivity: 'restricted',
      sourceType: 'official',
    });

    expect(n).toBe(2);
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(sql).toMatch(UPDATE_SQL);
    expect(sql).toMatch(/WHERE source_file = \$7/);
    expect(params).toEqual([
      'Judul Baru', 'SOP', 'regulatory', 'restricted', 'official', '2.0', 'sop.pdf',
    ]);
  });

  it('partial update leaves unspecified fields untouched (null params)', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await updateDocumentMetadata('sop.pdf', { docType: 'MEMO' });

    const params = vi.mocked(query).mock.calls[0]![1] as unknown[];
    expect(params).toEqual([null, 'MEMO', null, null, null, null, 'sop.pdf']);
  });

  it('treats empty-string version as absent (does not overwrite)', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await updateDocumentMetadata('sop.pdf', { version: '', title: 'T' });

    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(sql).toMatch(/WHEN \$6 IS NOT NULL AND \$6 <> ''/);
    expect((params as unknown[])[5]).toBe(''); // '' passes through, but SQL guard skips it
  });

  it('returns 0 when source_file has no chunks (route maps to 404)', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const n = await updateDocumentMetadata('missing.pdf', { title: 'X' });
    expect(n).toBe(0);
  });
});

describe('deleteDocumentBySourceFile', () => {
  it('deletes every chunk belonging to source_file', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 3 });

    const n = await deleteDocumentBySourceFile('sop.pdf');

    expect(n).toBe(3);
    expect(vi.mocked(query)).toHaveBeenCalledWith(
      'DELETE FROM knowledge_documents WHERE source_file = $1',
      ['sop.pdf'],
    );
  });

  it('returns 0 when source_file has no chunks (route maps to 404)', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const n = await deleteDocumentBySourceFile('missing.pdf');
    expect(n).toBe(0);
  });
});
