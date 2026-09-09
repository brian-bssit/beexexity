import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the knowledge search so no DB / Cohere embed is touched.
vi.mock('../../src/services/knowledge.service.js', () => ({
  search: vi.fn(),
}));

import { TIER1_TOOLS, execTier1Tool } from '../../src/services/tier1-tools.service.js';
import { search as searchMock } from '../../src/services/knowledge.service.js';
import { config } from '../../src/config/index.js';

function chunk(id: string, docType: string, title: string, content: string) {
  return { id, docType, title, content, score: 0.9, bindingLevel: 'standar', sourceType: 'upload' };
}

describe('tier1-tools.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(searchMock).mockResolvedValue([]);
  });

  it('config defaults keep the loop OFF and caps at safe values (zero-change anchor)', () => {
    // Feature is opt-in — without env flags the route never passes a toolLoop, so the
    // pre-feature 2-arg generate() path is byte-identical.
    expect(config.routing.tier1Tools.enabled).toBe(false);
    expect(config.routing.tier1Tools.modelId).toBe('');
    expect(config.routing.tier1Tools.maxIterations).toBe(3);
    expect(config.routing.tier1Tools.toolTopK).toBe(3);
  });

  it('registry exposes search_internal_knowledge with query required and doc_type optional', () => {
    expect(TIER1_TOOLS).toHaveLength(1);
    const spec = TIER1_TOOLS[0].toolSpec!;
    expect(spec.name).toBe('search_internal_knowledge');
    expect(spec.inputSchema.json.properties).toHaveProperty('query');
    expect(spec.inputSchema.json.properties).toHaveProperty('doc_type');
    expect(spec.inputSchema.json.required).toContain('query');
  });

  it('returns top toolTopK chunks IN FULL (count-capped, never truncated)', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      chunk(`c${i}`, 'SOP', `SOP ${i}`, `Isi lengkap chunk ${i}`.repeat(20)));
    vi.mocked(searchMock).mockResolvedValue(many);

    const out = await execTier1Tool('search_internal_knowledge', { query: 'prosedur cuti' });

    // search is called with a widened candidate set (topK*4 = 12 default), never the narrow cap.
    expect(searchMock).toHaveBeenCalledWith('prosedur cuti', 12);
    // default toolTopK = 3 → only 3 chunks returned, each with full content.
    expect(out.match(/\[Sumber:/g)).toHaveLength(3);
    expect(out).toContain(many[0].content);
    expect(out).not.toContain(many[3].content);
  });

  it('doc_type post-filters (case-insensitive) before capping', async () => {
    const mixed = [
      chunk('s', 'SOP', 'SOP A', 'isi sop'),
      chunk('k', 'KEBIJAKAN', 'Kebijakan B', 'isi kebijakan'),
      chunk('s2', 'SOP', 'SOP C', 'isi sop 2'),
      chunk('m', 'MEMO', 'Memo D', 'isi memo'),
    ];
    vi.mocked(searchMock).mockResolvedValue(mixed);

    const out = await execTier1Tool('search_internal_knowledge', { query: 'x', doc_type: 'sop' });

    expect(out).toContain('SOP A');
    expect(out).toContain('SOP C');
    expect(out).not.toContain('Kebijakan B');
    expect(out).not.toContain('Memo D');
  });

  it('search path is NOT PII-masked — raw content passes through verbatim', async () => {
    // A NIK + person name inside a chunk must survive untouched (masking would corrupt
    // internal retrieval — it is applied only at audit write time, never on the search path).
    const nik = '3201010101010001';
    const content = `Bapak Siti mengajukan dengan NIK ${nik} dan rekening 1234567890.`;
    vi.mocked(searchMock).mockResolvedValue([chunk('c', 'SOP', 'Data HR', content)]);

    const out = await execTier1Tool('search_internal_knowledge', { query: 'Siti pengajuan' });

    expect(out).toContain(content);
    expect(out).toContain(nik);
    expect(out).toContain('Bapak Siti');
  });

  it('unknown tool throws', async () => {
    await expect(execTier1Tool('not_a_tool', {})).rejects.toThrow('Unknown tier-1 tool');
  });

  it('empty query returns guidance without hitting search', async () => {
    const out = await execTier1Tool('search_internal_knowledge', { query: '   ' });
    expect(out).toContain('Query kosong');
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('no results degrades to a safe Indonesian message', async () => {
    vi.mocked(searchMock).mockResolvedValue([]);
    const out = await execTier1Tool('search_internal_knowledge', { query: 'tidak ada' });
    expect(out).toBe('Tidak ada hasil relevan dalam basis pengetahuan internal.');
    // Even a post-filter that empties the candidate set stays graceful.
    vi.mocked(searchMock).mockResolvedValue([chunk('m', 'MEMO', 'Memo X', 'isi')]);
    const out2 = await execTier1Tool('search_internal_knowledge', { query: 'x', doc_type: 'SOP' });
    expect(out2).toBe('Tidak ada hasil relevan dalam basis pengetahuan internal.');
  });
});
