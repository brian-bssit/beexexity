import { describe, it, expect, vi } from 'vitest';

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
  embeddingToSql,
  hashContent,
} from '../../src/services/embedding.service.js';

const { __mockSend: mockSend } = await import('@aws-sdk/client-bedrock-runtime') as any;

const DIMS = 1536;

function mockEmbeddingResponse(values: number[]): void {
  mockSend.mockResolvedValueOnce({
    body: new Uint8Array(Buffer.from(JSON.stringify({ embeddings: { float: [values] } }))),
  });
}

describe('generateEmbedding', () => {
  it('returns a Float32Array with the configured dimension', async () => {
    mockEmbeddingResponse(Array.from({ length: DIMS }, () => 0.5));

    const emb = await generateEmbedding('teks uji');
    expect(emb).toBeInstanceOf(Float32Array);
    expect(emb).toHaveLength(DIMS);
    expect(emb[0]).toBeCloseTo(0.5);
  });

  it('throws on dimension mismatch', async () => {
    mockEmbeddingResponse([0.1, 0.2]); // wrong length

    await expect(generateEmbedding('x')).rejects.toThrow(/dimension mismatch/i);
  });

  it('throws on empty or missing embedding', async () => {
    mockSend.mockResolvedValueOnce({ body: new Uint8Array(Buffer.from('{}')) });

    await expect(generateEmbedding('x')).rejects.toThrow(/dimension mismatch/i);
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
