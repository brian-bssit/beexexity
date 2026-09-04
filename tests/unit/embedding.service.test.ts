import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  const mockSend = vi.fn();
  return {
    BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
    InvokeModelCommand: vi.fn().mockImplementation((input) => input),
    __mockSend: mockSend,
  };
});

import {
  generateEmbedding,
  generateEmbeddings,
  embeddingToSql,
  hashContent,
} from '../../src/services/embedding.service.js';

const { __mockSend: mockSend } = await import('@aws-sdk/client-bedrock-runtime') as any;

const DIMS = 1536;

beforeEach(() => {
  vi.clearAllMocks();
});

function mockEmbeddingResponse(values: number[][]): void {
  mockSend.mockResolvedValueOnce({
    body: new Uint8Array(Buffer.from(JSON.stringify({ embeddings: { float: values } }))),
  });
}

describe('generateEmbedding', () => {
  it('returns a Float32Array with the configured dimension', async () => {
    mockEmbeddingResponse([Array.from({ length: DIMS }, () => 0.5)]);

    const emb = await generateEmbedding('teks uji');
    expect(emb).toBeInstanceOf(Float32Array);
    expect(emb).toHaveLength(DIMS);
    expect(emb[0]).toBeCloseTo(0.5);
  });

  it('throws on dimension mismatch', async () => {
    mockEmbeddingResponse([[0.1, 0.2]]); // wrong length

    await expect(generateEmbedding('x')).rejects.toThrow(/dimension mismatch/i);
  });

  it('throws on empty or missing embedding', async () => {
    mockSend.mockResolvedValueOnce({ body: new Uint8Array(Buffer.from('{}')) });

    await expect(generateEmbedding('x')).rejects.toThrow(/count mismatch/i);
  });
});

describe('generateEmbeddings', () => {
  it('returns one Float32Array per text in order', async () => {
    mockEmbeddingResponse([Array.from({ length: DIMS }, () => 0.1), Array.from({ length: DIMS }, () => 0.2)]);

    const embs = await generateEmbeddings(['a', 'b']);
    expect(embs).toHaveLength(2);
    expect(embs[0]).toBeInstanceOf(Float32Array);
    expect(embs[1]![0]).toBeCloseTo(0.2);
  });

  it('returns [] for no texts (no API call)', async () => {
    expect(await generateEmbeddings([])).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws when the API returns fewer embeddings than texts', async () => {
    mockEmbeddingResponse([Array.from({ length: DIMS }, () => 0.1)]); // 1 of 2 requested

    await expect(generateEmbeddings(['a', 'b'])).rejects.toThrow(/count mismatch/i);
  });
});

describe('embeddingToSql', () => {
  it('serializes to a pgvector literal', () => {
    const emb = new Float32Array([0.1, 0.25, 1]);
    expect(embeddingToSql(emb)).toBe('[0.1,0.25,1]');
  });
});

describe('hashContent', () => {
  it('returns a 16-char lowercase hex SHA-256 prefix', () => {
    const h = hashContent('dokumen rahasia');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic and distinct for different inputs', () => {
    expect(hashContent('a')).toBe(hashContent('a'));
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});
