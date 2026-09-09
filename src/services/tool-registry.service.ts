/**
 * Safe, deterministic tool registry for the external Tier-3 ReAct loop.
 * Tools are strictly public/mock data — no internal DB, PII, or knowledge access.
 * Only offered to allowlisted models (gate lives at the call site in inference.routes.ts).
 * @see docs/features/tier3-tools/
 */

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export const AVAILABLE_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_datetime',
      description: 'Get the current date and time in WIB (Asia/Jakarta). Use for "jam berapa", "tanggal berapa", "hari ini" questions.',
      parameters: { type: 'object', properties: {}, required: [] },
      strict: true,
    },
  },
];

/**
 * Execute a registry tool locally. Throws on unknown tool names — the caller
 * sanitizes the error (never leaks tool internals or keys to the client).
 */
export async function executeTool(name: string, _args: unknown): Promise<string> {
  if (name === 'get_current_datetime') {
    return new Date().toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      dateStyle: 'full',
      timeStyle: 'long',
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}
