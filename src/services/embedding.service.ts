/**
 * Embedding Service — generates vector embeddings via Bedrock Cohere Embed v4.
 * Reusable for any use case beyond the knowledge layer.
 * @see docs/features/mcp-knowledge-layer/
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { createHash } from 'node:crypto';
import { config } from '../config/index.js';

/** BedrockRuntimeClient configured for ap-southeast-3 (Jakarta). */
const bedrockClient = new BedrockRuntimeClient({
  region: config.aws.region,
});

/**
 * Generate a 1536-dim embedding via Cohere Embed v4 (only embed model in
 * ap-southeast-3; Titan Embed v2 is unavailable in this region).
 * Throws on dimension mismatch, empty response, or timeout.
 *
 * @param text - Text to embed
 * @param inputType - Cohere embedding type — 'search_document' for indexing,
 *                    'search_query' for retrieval queries
 */
export async function generateEmbedding(
  text: string,
  inputType: 'search_document' | 'search_query' = 'search_document',
): Promise<Float32Array> {
  return (await generateEmbeddings([text], inputType))[0]!;
}

/**
 * Generate embeddings for many texts in a single Cohere Embed v4 call.
 * Replaces N sequential calls (ingestion of large docs → ~250 chunks) with
 * ~ceil(N/96) round-trips.
 *
 * @param texts - Texts to embed (up to 96 per call)
 * @param inputType - 'search_document' for indexing, 'search_query' for retrieval
 * @param timeoutMs - Per-call abort timeout (defaults to config.knowledge.embeddingTimeoutMs)
 */
export async function generateEmbeddings(
  texts: string[],
  inputType: 'search_document' | 'search_query' = 'search_document',
  timeoutMs: number = config.knowledge.embeddingTimeoutMs,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = JSON.stringify({
      texts,
      input_type: inputType,
      embedding_types: ['float'],
    });

    const command = new InvokeModelCommand({
      modelId: config.knowledge.embeddingModel,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });

    const response = await bedrockClient.send(command, { abortSignal: controller.signal });
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
      embeddings?: { float?: number[][] };
    };
    const embeddings = parsed.embeddings?.float;

    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      throw new Error(
        `Embedding count mismatch: expected ${texts.length}, got ${Array.isArray(embeddings) ? embeddings.length : 'none'}`,
      );
    }
    for (const embedding of embeddings) {
      if (!Array.isArray(embedding) || embedding.length !== config.knowledge.embeddingDimensions) {
        throw new Error(
          `Embedding dimension mismatch: expected ${config.knowledge.embeddingDimensions}, got ${Array.isArray(embedding) ? embedding.length : 'none'}`,
        );
      }
    }

    return embeddings.map((e) => Float32Array.from(e));
  } finally {
    clearTimeout(timeout);
  }
}

/** Serialize a Float32Array into a pgvector literal: `[0.1,0.2,...]`. Rounded to 6 decimals. */
export function embeddingToSql(emb: Float32Array): string {
  return `[${Array.from(emb).map((v) => Number(v.toFixed(6))).join(',')}]`;
}

/** SHA-256 hash of a text, truncated to the first 16 hex chars (dedup key). */
export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Exposed for testing — allows injecting a mock client. */
export function _getBedrockClient(): BedrockRuntimeClient {
  return bedrockClient;
}

/** Exposed for testing — swaps the client instance. */
export function _setBedrockClient(client: BedrockRuntimeClient): void {
  (bedrockClient as { send: BedrockRuntimeClient['send'] }).send = client.send.bind(client);
}
