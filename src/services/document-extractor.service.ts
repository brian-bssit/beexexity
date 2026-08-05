/**
 * Document Extractor Service
 *
 * Extracts plain text from uploaded files. Each format has:
 *   - Format-aware text extraction
 *   - Format-specific sanitization (not generic regex)
 *   - Confidence scoring for the extracted content
 *
 * Where possible, output is converted to Markdown for better LLM comprehension:
 *   - DOCX → HTML → turndown (GFM) → Markdown
 *   - XLSX → SheetJS → Markdown tables
 *   - CSV → Markdown tables
 *   - JSON → fenced code block
 *
 * Confidences:
 *   high   — usable as-is for inference
 *   medium — usable but may be sparse; flagged in audit
 *   low    — routes to OCR pipeline (Nova Lite → GPT-OSS)
 *
 * Fail-closed on suspicious structures: DOCTYPE in XML, proto in JSON,
 * NULL bytes in CSV, executable content in HTML.
 *
 * @see Requirements 1.1, 1.2, 1.3
 */

import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { DocumentFile, ExtractionResult } from '../types/upload.types.js';
import { config } from '../config/index.js';
import { assertValidFileSignature } from './file-signature-validator.js';


// ─── ESM-Compatible Dynamic Imports ─────────────────────────────────────────────

let _officeParser: typeof import('officeparser') | null = null;
async function getOfficeParser(): Promise<typeof import('officeparser')> {
  if (!_officeParser) {
    _officeParser = await import('officeparser');
  }
  return _officeParser;
}

let _cheerio: typeof import('cheerio') | null = null;
async function getCheerio(): Promise<typeof import('cheerio')> {
  if (!_cheerio) {
    _cheerio = await import('cheerio');
  }
  return _cheerio;
}

let _xlsx: typeof import('xlsx') | null = null;
async function getXlsx(): Promise<typeof import('xlsx')> {
  if (!_xlsx) {
    _xlsx = await import('xlsx');
  }
  return _xlsx;
}

let _turndown: any = null;
let _gfm: any = null;
async function getTurndown(): Promise<any> {
  if (!_turndown) {
    _turndown = (await import('turndown')).default;
    _gfm = await import('turndown-plugin-gfm');
  }
  return _turndown;
}
function getGfmPlugin() { return _gfm; }

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Route to the appropriate extractor based on MIME type.
 * Validates file signature before extraction (fail-closed on mismatch).
 *
 * @throws Error with descriptive message for unsupported, corrupted, or suspicious files.
 */
export async function extractDocumentText(file: DocumentFile): Promise<ExtractionResult> {
  assertValidFileSignature(file);

  switch (file.mimetype) {
    case 'application/pdf':
      return extractPdfText(file.buffer, file.originalname);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocxText(file.buffer, file.originalname);
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return extractPptxText(file.buffer, file.originalname);
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.ms-excel':
      return extractXlsxText(file.buffer, file.originalname);
    case 'text/html':
      return extractHtmlText(file.buffer, file.originalname);
    case 'application/json':
      return extractJsonText(file.buffer, file.originalname);
    case 'text/csv':
      return extractCsvText(file.buffer, file.originalname);
    case 'text/markdown':
      return extractMarkdownText(file.buffer, file.originalname);
    case 'text/plain':
      return extractPlainText(file.buffer, file.originalname);
    case 'application/xml':
    case 'text/xml':
      return extractXmlText(file.buffer, file.originalname);
    default:
      throw new Error(`Unsupported document type: ${file.mimetype}`);
  }
}

// ─── PDF ────────────────────────────────────────────────────────────────────────

export async function extractPdfText(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  let parser: PDFParse | undefined;
  try {
    parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    const text = result.text.trim();
    const confidence = text.length > config.extraction.lowConfidenceThreshold ? 'high' as const : 'low' as const;
    return {
      text,
      filename,
      isEmpty: text.length === 0,
      confidence,
      format: 'pdf',
    };
  } catch {
    throw new Error(`Could not extract text from '${filename}'. File may be corrupted.`);
  } finally {
    if (parser) await parser.destroy();
  }
}

// ─── DOCX ───────────────────────────────────────────────────────────────────────

export async function extractDocxText(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  try {
    const htmlResult = await mammoth.convertToHtml({ buffer });
    const html = (htmlResult.value ?? '').trim();

    if (!html) {
      return { text: '', filename, isEmpty: true, confidence: 'low', format: 'docx' };
    }

    // Convert HTML → Markdown via turndown with GFM tables
    const Turndown = await getTurndown();
    const gfm = getGfmPlugin();
    const td = new Turndown({ headingStyle: 'atx' });
    if (gfm) {
      td.use(gfm.gfm);
    }
    const text = td.turndown(html).trim();

    const confidence = text.length > config.extraction.lowConfidenceThreshold ? 'high' as const : 'low' as const;
    return {
      text,
      filename,
      isEmpty: text.length === 0,
      confidence,
      format: 'docx',
    };
  } catch {
    throw new Error(`Could not extract text from '${filename}'. File may be corrupted.`);
  }
}

// ─── XLSX (SheetJS → Markdown tables) ────────────────────────────────────────

export async function extractXlsxText(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  try {
    const XLSX = await getXlsx();
    const workbook = XLSX.read(buffer, { type: 'buffer' });

    const parts: string[] = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const json: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      if (!json || json.length === 0) continue;

      parts.push(`## Sheet: ${sheetName}\n`);

      // Find the first row with content (header row)
      const headerRow = json.find((r: unknown[]) => r.some(c => c !== undefined && c !== null && c !== ''));

      if (!headerRow || !Array.isArray(headerRow)) continue;

      const headerIdx = json.indexOf(headerRow);
      const dataRows = json.slice(headerIdx + 1).filter((r: unknown[]) => r.some(c => c !== undefined && c !== null && c !== ''));

      // Escape pipe chars for Markdown
      const esc = (v: unknown): string => String(v ?? '').replace(/\|/g, '\\|');

      // Header
      parts.push(`| ${headerRow.map(esc).join(' | ')} |`);
      parts.push(`| ${headerRow.map(() => '---').join(' | ')} |`);

      // Data rows (cap at 500)
      const maxRows = 500;
      const truncated = dataRows.length > maxRows;
      const displayRows = truncated ? dataRows.slice(0, maxRows) : dataRows;

      for (const row of displayRows) {
        parts.push(`| ${(row as unknown[]).map(esc).join(' | ')} |`);
      }

      if (truncated) {
        parts.push('', `*... truncated ${dataRows.length - maxRows} rows *`);
      }

      parts.push('');
    }

    const text = parts.join('\n').trim();

    if (text.length === 0) {
      return { text: '', filename, isEmpty: true, confidence: 'low', format: 'xlsx' };
    }

    return {
      text,
      filename,
      isEmpty: false,
      confidence: 'high',
      format: 'xlsx',
    };
  } catch {
    throw new Error(`Could not extract text from '${filename}'. File may be corrupted or is not a valid spreadsheet.`);
  }
}

// ─── PPTX ───────────────────────────────────────────────────────────────────────

export async function extractPptxText(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  try {
    const officeParser = await getOfficeParser();
    const raw = await officeParser.parseOfficeAsync(buffer);
    const text = (raw ?? '').trim();

    if (text.length === 0) {
      return {
        text: '',
        filename,
        isEmpty: true,
        confidence: 'low',
        format: 'pptx',
      };
    }

    // Heuristic: if text is mostly slide titles separated by short fragments, confidence=medium
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    const avgLineLen = text.length / Math.max(lines.length, 1);
    const confidence = avgLineLen < 15 ? 'medium' as const : 'high' as const;

    return {
      text,
      filename,
      isEmpty: false,
      confidence,
      format: 'pptx',
    };
  } catch {
    throw new Error(`Could not extract text from '${filename}'. File may be corrupted or is not a valid PPTX.`);
  }
}

// ─── HTML (cheerio DOM sanitization, not regex) ─────────────────────────────────

export async function extractHtmlText(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  const cheerio = await getCheerio();
  const raw = buffer.toString('utf-8');

  // Step 1: Reject if binary content detected in first 4KB (likely spoofed)
  const head = raw.slice(0, 4096);
  let binaryCount = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c === 0 || (c < 8 && c !== 0)) binaryCount++;
  }
  if (binaryCount > 10) {
    throw new Error(`File '${filename}' declared as HTML but contains binary content.`);
  }

  // Step 2: Strip exec handlers BEFORE DOM parse (defense-in-depth)
  const noExec = raw.replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Step 3: Parse with cheerio — safe DOM, no script execution
  const $ = cheerio.load(noExec);

  // Step 4: Remove dangerous/irrelevant elements
  $('script, style, object, embed, iframe, meta, link, form, input, noslot, template').remove();

  // Step 5: Extract text — strip all attributes, no href/src preserved.
  // Output is pure text for AI ingestion. No downstream need for links.
  const text = ($('body').text() || $.text()).replace(/\s+/g, ' ').trim();

  if (text.length === 0) {
    return {
      text: '',
      filename,
      isEmpty: true,
      confidence: 'low',
      format: 'html',
    };
  }

  const confidence = text.length > config.extraction.lowConfidenceThreshold ? 'high' as const : 'low' as const;
  return {
    text,
    filename,
    isEmpty: false,
    confidence,
    format: 'html',
  };
}

// ─── JSON ───────────────────────────────────────────────────────────────────────

export async function extractJsonText(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  const raw = buffer.toString('utf-8').trim();
  if (!raw) {
    return { text: '', filename, isEmpty: true, confidence: 'low', format: 'json' };
  }

  // Reject if starts with binary signature
  if (raw.charCodeAt(0) === 0) {
    throw new Error(`File '${filename}' declared as JSON but appears to be binary.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`File '${filename}' is not valid JSON.`);
  }

  // Depth check — reject nested structures beyond limit
  const depth = getDepth(parsed);
  if (depth > config.extraction.maxJsonDepth) {
    console.error(`[extraction] JSON depth ${depth} exceeds max ${config.extraction.maxJsonDepth} — rejecting`, { filename, depth });
    throw new Error(`JSON in '${filename}' is too deeply nested (depth ${depth}, max ${config.extraction.maxJsonDepth}).`);
  }

  // Reject __proto__ / constructor keys (prototype pollution)
  if (hasDangerousKeys(parsed)) {
    throw new Error(`File '${filename}' contains forbidden keys (__proto__ or constructor).`);
  }

  // Prettify and wrap in fenced code block for structured AI consumption
  const prettified = JSON.stringify(parsed, null, 2);
  const text = `\`\`\`json\n${prettified}\n\`\`\``;

  return {
    text,
    filename,
    isEmpty: false,
    confidence: 'high',
    format: 'json',
  };
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/**
 * Convert CSV rows to a Markdown table.
 * Capped at 500 data rows to prevent context window overflow.
 */
function csvToMarkdownTable(raw: string, maxRows: number = 500): string {
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return '';

  const header = lines[0];
  const dataLines = lines.slice(1);
  const truncated = dataLines.length > maxRows;
  const rows = truncated ? dataLines.slice(0, maxRows) : dataLines;

  // Helper: escape pipe chars inside cells
  const esc = (s: string) => s.replace(/\|/g, '\\|');

  const parts: string[] = [];

  // Header row
  const headerCells = header.split(',').map(esc);
  parts.push(`| ${headerCells.join(' | ')} |`);
  // Separator row
  parts.push(`| ${headerCells.map(() => '---').join(' | ')} |`);
  // Data rows
  for (const row of rows) {
    const cells = row.split(',').map(esc);
    parts.push(`| ${cells.join(' | ')} |`);
  }

  if (truncated) {
    parts.push('', `*... truncated ${dataLines.length - maxRows} rows *`);
  }

  return parts.join('\n');
}

export async function extractCsvText(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  let raw = buffer.toString('utf-8');

  // Strip BOM
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  }

  // Reject NULL bytes
  if (raw.includes('\0')) {
    throw new Error(`File '${filename}' contains binary NULL bytes — rejecting.`);
  }

  // Cap raw rows
  const allLines = raw.split('\n');
  if (allLines.length > config.extraction.maxCsvRows) {
    console.error(`[extraction] CSV row count ${allLines.length} exceeds max ${config.extraction.maxCsvRows} — returning empty`, { filename });
    return { text: '', filename, isEmpty: true, confidence: 'low', format: 'csv' };
  }

  if (allLines.filter(l => l.trim()).length === 0) {
    return { text: '', filename, isEmpty: true, confidence: 'low', format: 'csv' };
  }

  const text = csvToMarkdownTable(raw);

  return {
    text,
    filename,
    isEmpty: false,
    confidence: 'high',
    format: 'csv',
  };
}

// ─── Plain Text ────────────────────────────────────────────────────────────

export async function extractPlainText(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  let raw = buffer.toString('utf-8');

  // Strip BOM
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  }

  // Reject NULL bytes
  if (raw.includes('\0')) {
    throw new Error(`File '${filename}' contains binary NULL bytes — rejecting.`);
  }

  const text = raw.trim();

  if (text.length === 0) {
    return { text: '', filename, isEmpty: true, confidence: 'low', format: 'text' };
  }

  return {
    text,
    filename,
    isEmpty: false,
    confidence: 'high',
    format: 'text',
  };
}

// ─── Markdown ──────────────────────────────────────────────────────────────

export async function extractMarkdownText(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  const result = await extractPlainText(buffer, filename);
  if (result.isEmpty) return { ...result, format: 'markdown' };

  // Strip image references: ![alt](url) and [alt](url) that look like images
  const text = result.text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\[[^\]]+\]/g, '$1') // ![alt][ref] → alt
    .trim();

  return {
    ...result,
    text,
    format: 'markdown',
  };
}

// ─── XML ───────────────────────────────────────────────────────────────────

export async function extractXmlText(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  const raw = buffer.toString('utf-8').trim();
  if (!raw) {
    return { text: '', filename, isEmpty: true, confidence: 'low', format: 'xml' };
  }

  // Reject DOCTYPE declarations (XXE guard — fail-closed)
  if (/<!DOCTYPE\s+/i.test(raw) || /<!ENTITY\s+/i.test(raw)) {
    console.error(`[extraction] XML in '${filename}' contains DOCTYPE/ENTITY declaration — rejecting (XXE guard)`, { filename });
    throw new Error(`File '${filename}' contains DOCTYPE or ENTITY declarations which are not allowed.`);
  }

  // Reject binary content
  let binaryCount = 0;
  for (let i = 0; i < Math.min(1024, raw.length); i++) {
    const c = raw.charCodeAt(i);
    if (c === 0) binaryCount++;
  }
  if (binaryCount > 5) {
    throw new Error(`File '${filename}' declared as XML but contains binary content.`);
  }

  // Strip processing instructions (<?...?>)
  const noPis = raw.replace(/<\?[^?]+\?>/g, '');

  // Strip XML tags, preserve text content
  const text = noPis
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length === 0) {
    return { text: '', filename, isEmpty: true, confidence: 'low', format: 'xml' };
  }

  return {
    text,
    filename,
    isEmpty: false,
    confidence: 'high',
    format: 'xml',
  };
}

// ─── Private Helpers ────────────────────────────────────────────────────────────

/**
 * Get nesting depth of a JSON value.
 */
function getDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    return 1 + value.reduce((max, item) => Math.max(max, getDepth(item)), 0);
  }
  const vals = Object.values(value as Record<string, unknown>);
  return 1 + (vals as unknown[]).reduce<number>((max, v) => Math.max(max, getDepth(v)), 0);
}

/**
 * Check for dangerous keys (__proto__, constructor) in any position.
 */
function hasDangerousKeys(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item: unknown) => hasDangerousKeys(item));
  }
  const obj = value as Record<string, unknown>;
  // Use hasOwn to check own properties only — 'constructor in obj' is always
  // true for plain objects (inherited from Object.prototype).
  if (Object.hasOwn(obj, '__proto__') || Object.hasOwn(obj, 'constructor')) return true;
  for (const v of Object.values(obj)) {
    if (hasDangerousKeys(v)) return true;
  }
  return false;
}
