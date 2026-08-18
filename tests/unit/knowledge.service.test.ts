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

import { query } from '../../src/config/database.js';
import { search, indexDocument, deleteDocument } from '../../src/services/knowledge.service.js';

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
  metadata: { binding_level: 'regulatory', source_type: 'internal' },
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

  it('falls back to ILIKE keyword search when semantic score is below threshold', async () => {
    mockEmbedding();
    const weak = { ...CHUNK_ROW, score: 0.2 }; // < hybridThreshold 0.4
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [weak] }) // cosine query — low score
      .mockResolvedValueOnce({ rows: [{ ...CHUNK_ROW, score: undefined }] }); // keyword query

    const results = await search('Pasal 22 UU PDP', 3);

    // ILIKE rows carry no score → 0, but pass through (exact match, high precision)
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('SOP Pengajuan Kredit');
  });

  it('tokenizes the query into OR keywords instead of full-phrase match', async () => {
    mockEmbedding();
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ ...CHUNK_ROW, score: 0.2 }] }) // cosine — low
      .mockResolvedValueOnce({ rows: [{ ...CHUNK_ROW, score: undefined }] }); // keyword

    await search('berapa hari cuti tahunan', 3);

    const kwSql = vi.mocked(query).mock.calls[1][0] as string;
    expect(kwSql).toMatch(/content ILIKE \$1/);
    expect(kwSql).toContain(' OR ');
    expect(kwSql).not.toContain('%berapa hari cuti tahunan%');
  });

  it('degrades gracefully to [] on DB error', async () => {
    mockEmbedding();
    vi.mocked(query).mockRejectedValueOnce(new Error('db down'));

    const results = await search('apa saja', 3);
    expect(results).toEqual([]);
  });
});

describe('indexDocument', () => {
  it('chunks, embeds, dedups, and inserts', async () => {
    mockEmbedding();
    vi.mocked(query)
      // dedup check — none exists
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
  });

  it('skips duplicate chunks by content hash', async () => {
    mockEmbedding();
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: 'existing' }] }); // dedup hit

    const result = await indexDocument({
      content: 'konten yang sama persis',
      docType: 'MEMO',
      title: 'Dup',
      sourceFile: 'dup.pdf',
    });

    expect(result.chunkIndex).toBe(0); // nothing inserted
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1); // only the dedup SELECT
  });

  it('splits long content into multiple chunks', async () => {
    const longContent = `${'kalimat. '.repeat(1200)}`; // ~9.6K chars → multiple chunks

    mockEmbedding();
    let insertCount = 0;
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT id FROM knowledge_documents WHERE content_hash')) {
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

describe('deleteDocument', () => {
  it('deletes a knowledge document row', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [] });

    await deleteDocument('c1');
    expect(vi.mocked(query)).toHaveBeenCalledWith(
      'DELETE FROM knowledge_documents WHERE id = $1',
      ['c1'],
    );
  });
});
