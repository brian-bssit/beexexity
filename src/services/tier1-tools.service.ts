/**
 * Tier-1 (private Bedrock) tool registry + executor for the bounded ReAct loop.
 * Internal-only access — searches the pgvector knowledge base the gateway already
 * owns (same semantic `search` fn as Auto-RAG). The search path is intentionally NOT
 * PII-masked: everything stays inside the private gateway, and masking a query would
 * corrupt the vector search. Audit masks at write time instead.
 * @see docs/features/tier1-tools/
 */

import { type Tool } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config/index.js';
import { search as searchKnowledge } from './knowledge.service.js';

/** Native Bedrock `toolConfig.tools[]` entry (SDK type). */
export type Tier1ToolSpec = Tool;

/** Bedrock toolConfig shape. */
export interface Tier1ToolConfig {
  tools: Tool[];
}

export const TIER1_TOOLS: Tool[] = [
  {
    toolSpec: {
      name: 'search_internal_knowledge',
      description:
        'Search the internal knowledge base (SOP/kebijakan/prosedur perbankan, FAQ, memo). ' +
        'Call it when the context already provided is not enough to answer completely, or to ' +
        'follow a cross-reference (multi-hop). Returns the top matching chunks verbatim.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Free-text search query, e.g. "SOP pengajuan cuti karyawan"' },
            doc_type: {
              type: 'string',
              description: 'Optional document-type filter, e.g. SOP, KEBIAKAN, MEMO, PRODUCT_FAQ',
            },
          },
          required: ['query'],
        },
      },
    },
  },
] as Tool[];

/** Build the `toolConfig` fragment for a ConverseStreamCommand. */
export function tier1ToolConfig(): Tier1ToolConfig {
  return { tools: TIER1_TOOLS };
}

/**
 * Execute a Tier-1 tool locally. Always returns a safe display string.
 * Unknown tools throw — the caller sanitizes. Search itself never throws
 * (`knowledge.service.search` self-timeouts and degrades to []).
 */
export async function execTier1Tool(name: string, args: unknown): Promise<string> {
  if (name !== 'search_internal_knowledge') {
    throw new Error(`Unknown tier-1 tool: ${name}`);
  }

  const a = (args ?? {}) as Record<string, unknown>;
  const query = typeof a.query === 'string' && a.query.trim() ? a.query.trim() : '';
  if (!query) return 'Query kosong. Berikan kata kunci pencarian yang spesifik.';

  const docType = typeof a.doc_type === 'string' && a.doc_type.trim() ? a.doc_type.trim().toUpperCase() : null;

  // Fetch a wider candidate set than we return so a doc_type post-filter can't starve
  // the result. `search` returns [] on failure/timeout → graceful, indistinguishable
  // from "no results".
  const topK = config.routing.tier1Tools.toolTopK;
  const candidates = await searchKnowledge(query, Math.max(topK * 4, 12));
  const chunks = (docType ? candidates.filter((c) => c.docType.toUpperCase() === docType) : candidates)
    .slice(0, topK);

  if (chunks.length === 0) {
    return 'Tidak ada hasil relevan dalam basis pengetahuan internal.';
  }

  // Mirror the Auto-RAG citation header so tool-fed references cite consistently.
  return chunks.map((c) => `[Sumber: ${c.title}]\n${c.content}`).join('\n\n');
}
