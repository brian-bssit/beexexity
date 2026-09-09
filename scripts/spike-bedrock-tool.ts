/**
 * Spike: Bedrock ConverseStream tool-use interception (tier1-tools Wave 0).
 * Answers, against the real model, the 4 spike questions:
 *   1a. Does qwen3-235b emit TEXT preamble deltas before contentBlockStart(toolUse)?
 *   1b. Is the toolUse response shape parseable (start→delta fragments→stop)?
 *   1c. Round-trip latency: contentBlockStop → local tool exec → round-2 first text delta.
 *   1d. (no-tool baseline) plain ConverseStream reply for a same prompt.
 *
 * Usage: npx tsx scripts/spike-bedrock-tool.ts
 * Requires live AWS creds in .env (Bedrock Account #1, ap-southeast-3).
 */
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../src/config/index.js';

const MODEL = config.routing.autoModelId; // qwen.qwen3-235b-a22b-2507-v1:0
const client = new BedrockRuntimeClient({ region: config.aws.region });

const TOOLS = [
  {
    toolSpec: {
      name: 'search_internal_knowledge',
      description:
        'Search the internal knowledge base (SOP/kebijakan/prosedur perbankan) for documents. ' +
        'Use when the provided context is insufficient or you need a specific procedure/form.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Pencarian teks bebas, mis. "SOP pengajuan cuti"' },
            doc_type: { type: 'string', description: 'Filter opsional jenis dokumen, mis. SOP' },
          },
          required: ['query'],
        },
      },
    },
  },
];

const PROMPT =
  'Saya perlu SOP pengajuan cuti karyawan. Jelaskan langkah-langkahnya dan sebutkan ' +
  'formulir apa saja yang harus dilampirkan. Jika butuh dokumen, gunakan tool pencarian.';

async function streamOnce(label: string, messages: unknown[], withTools: boolean) {
  const command = new ConverseStreamCommand({
    modelId: MODEL,
    messages: messages as never,
    ...(withTools ? { toolConfig: { tools: TOOLS } } : {}),
    inferenceConfig: { maxTokens: 1024, temperature: 0.2 },
  });
  const resp = await client.send(command);
  const out = {
    label,
    events: [] as Array<Record<string, unknown>>,
    text: '',
    toolUses: [] as Array<{ index: number; id?: string; name?: string; input: string }>,
  };
  const blockType = new Map<number, string>();
  for await (const ev of resp.stream ?? []) {
    if (ev.contentBlockStart) {
      const idx = ev.contentBlockStart.contentBlockIndex;
      const ts = ev.contentBlockStart.start?.toolUse;
      const type = ts ? 'toolUse' : 'text';
      blockType.set(idx, type);
      out.events.push({ t: 'start', index: idx, type, toolUse: ts ? { id: ts.toolUseId, name: ts.name } : undefined });
      if (ts) out.toolUses.push({ index: idx, id: ts.toolUseId, name: ts.name, input: '' });
    } else if (ev.contentBlockDelta) {
      const idx = ev.contentBlockDelta.contentBlockIndex;
      const d = ev.contentBlockDelta.delta;
      if (d?.text) {
        out.text += d.text;
        out.events.push({ t: 'textDelta', index: idx });
      } else if (d?.toolUse?.input) {
        const entry = out.toolUses.find((tu) => tu.index === idx);
        if (entry) entry.input += d.toolUse.input;
        out.events.push({ t: 'toolDelta', index: idx, frag: String(d.toolUse.input) });
      } else {
        out.events.push({ t: 'delta(no text/tool)', index: idx });
      }
    } else if (ev.contentBlockStop) {
      out.events.push({ t: 'blockStop', index: ev.contentBlockStop.contentBlockIndex });
    } else if (ev.messageStart) {
      out.events.push({ t: 'messageStart', role: ev.messageStart.role });
    } else if (ev.messageStop) {
      out.events.push({ t: 'messageStop', stopReason: ev.messageStop.stopReason });
    } else if (ev.metadata) {
      out.events.push({ t: 'metadata', usage: ev.metadata.usage });
    } else if (ev.internalServerException || ev.modelStreamErrorException || ev.throttlingException) {
      out.events.push({ t: 'error', k: Object.keys(ev).filter((k) => ev[k as keyof typeof ev]) });
    }
  }
  return out;
}

function summarize(label: string, r: { text: string; toolUses: Array<{ id?: string; name?: string; input: string }>; events: Array<Record<string, unknown>> }) {
  const firstTextIdx = r.events.findIndex((e) => e.t === 'textDelta');
  const firstToolStartIdx = r.events.findIndex((e) => e.t === 'start' && (e as { toolUse?: unknown }).toolUse);
  console.log(`\n── ${label} ──`);
  console.log(`  toolUses: ${r.toolUses.length} → ${JSON.stringify(r.toolUses.map((t) => ({ id: t.id, name: t.name, inputParsed: safeParse(t.input) })))}`);
  console.log(`  text: ${r.text.length} chars${r.text ? ` | preview: "${r.text.slice(0, 90)}…"` : ' (none)'}`);
  console.log(`  [1a] text BEFORE first toolUse? ${firstTextIdx !== -1 && (firstToolStartIdx === -1 || firstTextIdx < firstToolStartIdx) ? 'YES' : 'no'}`);
  console.log(`  [1b] parseable start→delta→stop? ${/start/.test(r.events.map((e) => e.t).join(',')) ? 'start seen' : ''} ${r.events.some((e) => e.t === 'blockStop') ? 'blockStop seen' : ''}`);
  console.log(`  events: ${r.events.map((e) => e.t).join(' | ')}`);
}

function safeParse(s: string) {
  try { return JSON.parse(s); } catch { return s; }
}

/** Bedrock requires toolUse.input to be a JSON object — never a bare string. */
function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

async function main() {
  console.log(`Model: ${MODEL} · region ${config.aws.region}`);

  // ── Baseline (no tools) ─────────────────────────────────────────────
  const baseStart = Date.now();
  const base = await streamOnce('BASELINE (no tools)', [{ role: 'user', content: [{ text: PROMPT }] }], false);
  console.log(`\nBASELINE latency: ${Date.now() - baseStart}ms, text ${base.text.length} chars`);

  // ── Round 1: with tools, forced call ────────────────────────────────
  const t0 = Date.now();
  const r1 = await streamOnce('ROUND 1 (tools)', [{ role: 'user', content: [{ text: PROMPT }] }], true);
  summarize('ROUND 1 (tools)', r1);
  const r1Dur = Date.now() - t0;

  // ── Round 2: if tool use detected, execute + resend history ─────────
  if (r1.toolUses.length === 0) {
    console.log('\n⚠️  No toolUse in round 1 — model answered from memory. Re-running with a harder prompt…');
    return;
  }
  const toolStart = Date.now();
  // local tool execution stub (spike — returns canned text)
  const resultText = 'SOP Pengajuan Cuti (dummy): 1. Ajukan via portal HR. 2. Lampirkan Form Cuti (FC-01) dan surat delegasi. 3. Approve atasan.';
  const toolMs = Date.now() - toolStart;
  console.log(`\n[tool exec stub] ${toolMs}ms`);

  const toolResults = r1.toolUses.map((tu) => ({
    role: 'user',
    content: [{ toolResult: { toolUseId: tu.id, content: [{ text: resultText }], status: 'success' } }],
  }));
  const history = [
    { role: 'user', content: [{ text: PROMPT }] },
    { role: 'assistant', content: r1.toolUses.map((tu) => ({ toolUse: { toolUseId: tu.id, name: tu.name, input: asObject(safeParse(tu.input)) } })) },
    ...toolResults,
  ];
  const t1 = Date.now();
  const r2 = await streamOnce('ROUND 2 (resend history + result)', history, true);
  summarize('ROUND 2', r2);
  const r2FirstDelta = r2.text.length ? Date.now() - t1 : 0;

  console.log(`\n[1c] round-1 duration ${r1Dur}ms · round-2→first-text ${r2FirstDelta}ms · tool exec ${toolMs}ms`);
  console.log('\nSPIKE DONE — record answers in docs/features/tier1-tools/ before Wave 1.');
}

main().catch((e) => {
  console.error('\n❌ SPIKE FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
