/**
 * Ingest Knowledge CLI — bulk-index a folder of documents into the knowledge base.
 *
 * Usage:
 *   npx tsx src/scripts/ingest-knowledge.ts --dir ./knowledge
 *
 * Supported formats: PDF, DOCX, PPTX, XLSX, HTML, JSON, CSV, XML, MD, TXT.
 *
 * Metadata sources (highest precedence wins):
 *   1. JSON sidecar `<basename>.json` next to the file
 *   2. Markdown YAML front-matter (for .md files)
 *   3. Filename convention `{doc_type}_{title}.{ext}`
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { extractDocumentText } from '../services/document-extractor.service.js';
import { indexDocument } from '../services/knowledge.service.js';
import type { IndexDocumentParams } from '../types/knowledge.types.js';

/** Extension → MIME type, for routing through extractDocumentText. */
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

/** Files whose text is plain text — read raw, no extractor needed. */
const RAW_TEXT: Record<string, boolean> = { '.md': true, '.txt': true };

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (extname(full).toLowerCase() in MIME) {
      out.push(full);
    }
  }
  return out;
}

/** Minimal YAML front-matter parser — flat `key: value` only, adequate for ingestion metadata. */
function parseFrontMatter(raw: string): { metadata: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { metadata: {}, body: raw };

  const metadata: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [key, ...rest] = line.split(':');
    if (!key || rest.length === 0) continue;
    const value = rest.join(':').trim();
    if (/^\[.*\]$/.test(value)) {
      metadata[key.trim()] = value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (/^(true|false)$/.test(value)) {
      metadata[key.trim()] = value === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      metadata[key.trim()] = Number(value);
    } else {
      metadata[key.trim()] = value.replace(/^['"]|['"]$/g, '');
    }
  }
  return { metadata, body: raw.slice(m[0].length) };
}

/** Parse metadata from the filename convention `{doc_type}_{title}.{ext}`. */
function fromFilename(filepath: string): Partial<IndexDocumentParams> {
  const name = basename(filepath, extname(filepath));
  const sep = name.indexOf('_');
  if (sep <= 0) return { docType: 'DOC', title: name.replace(/_/g, ' ') };
  const docType = name.slice(0, sep).toUpperCase();
  const title = name.slice(sep + 1).replace(/_/g, ' ');
  return { docType, title };
}

/** Metadata keys accepted from sidecar JSON or front-matter, mapped to IndexDocumentParams. */
const META_KEYS: Record<string, keyof IndexDocumentParams> = {
  doc_type: 'docType',
  title: 'title',
  version: 'version',
  effective_date: 'effectiveDate',
  expiry_date: 'expiryDate',
  domain: 'domain',
  sensitivity: 'sensitivity',
  jurisdiction: 'jurisdiction',
  source_type: 'sourceType',
  binding_level: 'bindingLevel',
};

function toIndexParams(meta: Record<string, unknown>): Partial<IndexDocumentParams> {
  const params: Partial<IndexDocumentParams> = {};
  for (const [k, v] of Object.entries(meta)) {
    const target = META_KEYS[k];
    if (target && v !== undefined && v !== null && v !== '') {
      (params as Record<string, unknown>)[target] = v;
    }
  }
  return params;
}

async function ingestOne(filepath: string): Promise<void> {
  const fromName = fromFilename(filepath);

  // 1. Raw text files: read directly (also captures front-matter).
  let content: string;
  let fm: Record<string, unknown> = {};
  if (RAW_TEXT[extname(filepath).toLowerCase()]) {
    const raw = readFileSync(filepath, 'utf-8');
    const parsed = parseFrontMatter(raw);
    fm = parsed.metadata;
    content = parsed.body.trim();
  } else {
    const buffer = readFileSync(filepath);
    const result = await extractDocumentText({
      buffer,
      mimetype: MIME[extname(filepath).toLowerCase()]!,
      originalname: basename(filepath),
      size: buffer.length,
    });
    content = result.text.trim();
  }

  if (!content) {
    console.log(`[knowledge] Skipped (empty extraction): ${filepath}`);
    return;
  }

  // 2. Sidecar JSON metadata (highest precedence).
  const sidecar = `${filepath}.json`;
  let fromSidecar: Record<string, unknown> = {};
  if (existsSync(sidecar)) {
    fromSidecar = JSON.parse(readFileSync(sidecar, 'utf-8')) as Record<string, unknown>;
  }

  const params: IndexDocumentParams = {
    content,
    sourceFile: basename(filepath),
    docType: fromName.docType ?? 'DOC',
    title: fromName.title ?? basename(filepath),
    ...toIndexParams(fm),
    ...toIndexParams(fromSidecar),
  };

  const result = await indexDocument(params);
  console.log(`[knowledge] Indexed ${params.title} → ${result.chunkIndex} chunk(s)`);
}

async function main(): Promise<void> {
  const dirIdx = process.argv.indexOf('--dir');
  const dir = dirIdx !== -1 ? resolve(process.argv[dirIdx + 1] ?? '.') : resolve('knowledge');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const files = walk(dir);
  console.log(`[knowledge] Found ${files.length} document(s) in ${dir}`);

  for (const file of files) {
    try {
      await ingestOne(file);
    } catch (error) {
      console.error(`[knowledge] Failed ${file}:`, (error as Error).message);
    }
  }
}

await main();
