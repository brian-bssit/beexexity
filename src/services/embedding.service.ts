/**
 * Embedding Service — generates vector embeddings via Bedrock Titan Embeddings v2.
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
 * Generate a normalized 1024-dim embedding for a text.
 * Throws on dimension mismatch, empty response, or timeout.
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.knowledge.embeddingTimeoutMs);

  try {
    const body = JSON.stringify({
      inputText: text,
      dimensions: config.knowledge.embeddingDimensions,
      normalize: true,
    });

    const command = new InvokeModelCommand({
      modelId: config.knowledge.embeddingModel,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });

    const response = await bedrockClient.send(command, { abortSignal: controller.signal });
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as { embedding?: unknown };
    const embedding = parsed.embedding;

    if (!Array.isArray(embedding) || embedding.length !== config.knowledge.embeddingDimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${config.knowledge.embeddingDimensions}, got ${Array.isArray(embedding) ? embedding.length : 'none'}`,
      );
    }

    return Float32Array.from(embedding);
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
