/**
 * Gotenberg Service — converts legacy Office documents (.doc, .ppt) to PDF
 * via Gotenberg's LibreOffice endpoint, then extracts text using pdf-parse.
 *
 * Gotenberg is deployed as a separate Cloud Run service:
 *   - Image: gotenberg/gotenberg:8
 *   - Endpoint: /forms/libreoffice/convert
 *   - Resources: 2 vCPU / 4GB RAM
 *
 * GOTENBERG_URL env var must point to the Gotenberg service (e.g.
 * https://gotenberg-xxxxx-uc.a.run.app).
 *
 * @see Requirements 1.1, 1.2
 */

import { config } from '../config/index.js';
import { extractPdfText } from './document-extractor.service.js';
import type { ExtractionResult } from '../types/upload.types.js';

/**
 * Convert a legacy Office document (.doc, .ppt) to text via Gotenberg → PDF → pdf-parse.
 *
 * Steps:
 *   1. POST file buffer to Gotenberg /forms/libreoffice/convert
 *   2. Receive PDF response
 *   3. Extract text from PDF via pdf-parse
 *
 * Graceful degradation: returns low-confidence empty result if Gotenberg is
 * not configured or unreachable. Never throws.
 */
export async function convertViaGotenberg(
  buffer: Buffer,
  filename: string,
): Promise<ExtractionResult> {
  const gotenbergUrl = config.gotenberg.url;
  if (!gotenbergUrl) {
    console.warn('[gotenberg] GOTENBERG_URL not configured — skipping conversion');
    return { text: '', filename, isEmpty: true, confidence: 'low', format: 'unknown' };
  }

  const ext = filename.split('.').pop()?.toLowerCase() || 'doc';
  const endpoint = `${gotenbergUrl}/forms/libreoffice/convert`;

  try {
    // Build multipart form
    const form = new FormData();
    form.append('files', new Blob([buffer as any], { type: 'application/octet-stream' }), filename);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.gotenberg.timeoutMs);

    const response = await fetch(endpoint, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[gotenberg] API returned ${response.status} for ${filename}`);
      return { text: '', filename, isEmpty: true, confidence: 'low', format: ext };
    }

    // Response is a PDF — extract text via pdf-parse
    const pdfBuffer = Buffer.from(await response.arrayBuffer());
    const result = await extractPdfText(pdfBuffer, filename.replace(/\.(doc|ppt)$/i, '.pdf'));

    return {
      ...result,
      format: ext, // Report original format, not pdf
    };
  } catch (error) {
    console.error(`[gotenberg] Conversion failed for ${filename}:`, (error as Error).message);
    return { text: '', filename, isEmpty: true, confidence: 'low', format: ext };
  }
}

/**
 * Convert a .pptx buffer to PDF via Gotenberg LibreOffice.
 * Returns raw PDF buffer. Throws on failure.
 */
export async function convertPptxToPdf(pptxBuffer: Buffer, filename: string = 'presentation.pptx'): Promise<Buffer> {
  const gotenbergUrl = config.gotenberg.url;
  if (!gotenbergUrl) {
    throw new Error('GOTENBERG_URL not configured');
  }

  const form = new FormData();
  form.append('files', new Blob([pptxBuffer as any], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), filename);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.gotenberg.timeoutMs);

  try {
    const response = await fetch(`${gotenbergUrl}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Gotenberg returned ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Convert HTML to PDF via Gotenberg Chromium.
 * Supports two formats:
 *   - 'slide' (PPTX): 16:9 ratio, zero margins, print backgrounds
 *   - 'document' (PDF): A4, 2cm margins, CSS @page honored
 */
export async function htmlToPdfViaGotenberg(html: string, format: 'slide' | 'document' = 'slide'): Promise<Buffer> {
  const gotenbergUrl = config.gotenberg.url;
  if (!gotenbergUrl) throw new Error('GOTENBERG_URL not configured');

  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  const form = new FormData();
  form.append('files', new Blob([fullHtml], { type: 'text/html' }), 'index.html');

  if (format === 'document') {
    // A4 document — use CSS @page from the HTML, with sensible Gotenberg defaults
    form.append('paperWidth', '8.27');   // A4
    form.append('paperHeight', '11.69');
    form.append('marginTop', '0.79');    // 2cm
    form.append('marginBottom', '0.79');
    form.append('marginLeft', '0.79');
    form.append('marginRight', '0.79');
    form.append('preferCssPageSize', 'true');  // honor CSS @page { size: A4; margin: 2cm; }
  } else {
    // 16:9 slide — exact dimensions for presentation export
    form.append('paperWidth', '13.33');
    form.append('paperHeight', '7.5');
    form.append('marginTop', '0');
    form.append('marginBottom', '0');
    form.append('marginLeft', '0');
    form.append('marginRight', '0');
    form.append('preferCssPageSize', 'true');
  }
  form.append('printBackground', 'true');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.gotenberg.timeoutMs);

  try {
    const response = await fetch(`${gotenbergUrl}/forms/chromium/convert/html`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Gotenberg Chromium PDF returned ${response.status}: ${errText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

import JSZip from 'jszip';
import * as cheerio from 'cheerio';

// ── PPTX Builder (text-based via JSZip + cheerio — zero extra deps) ──

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textRun(text: string, opts?: { bold?: boolean; size?: number; color?: string }): string {
  const sz = opts?.size || 1800; const b = opts?.bold ? ' b="1"' : '';
  const c = opts?.color || '1A365D';
  return '<a:r><a:rPr lang="en-US" sz="' + sz + '"' + b + '><a:solidFill><a:srgbClr val="' + c + '"/></a:solidFill></a:rPr><a:t>' + escapeXml(text) + '</a:t></a:r>';
}

function buildSlideXml(title: string, bodyElements: string[], isHero: boolean, isCenter: boolean): string {
  const shapes: string[] = []; let id = 1;
  if (title) {
    const ts = isHero ? 3600 : 2800; const tx = isCenter ? 1000000 : 800000;
    const ty = isCenter ? 2500000 : 400000; const tw = isCenter ? 10200000 : 10600000;
    const th = isHero ? 1200000 : 700000; const tc = isHero ? 'FFFFFF' : '1A365D';
    shapes.push('<p:sp><p:nvSpPr><p:cNvPr id="' + (id++) + '" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="' + tx + '" y="' + ty + '"/><a:ext cx="' + tw + '" cy="' + th + '"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="' + (isCenter ? 'ctr' : 'l') + '"/>' + textRun(title, { bold: true, size: ts, color: tc }) + '</a:p></p:txBody></p:sp>');
  }
  let yOff = isCenter ? 4000000 : 1400000;
  for (const body of bodyElements) {
    const bx = isCenter ? 1500000 : 800000; const bw = isCenter ? 9200000 : 10600000;
    const bc = isHero ? 'E8ECF1' : '2D3748';
    shapes.push('<p:sp><p:nvSpPr><p:cNvPr id="' + (id++) + '" name="Body"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="' + bx + '" y="' + yOff + '"/><a:ext cx="' + bw + '" cy="600000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="' + (isCenter ? 'ctr' : 'l') + '"/>' + textRun(body, { color: bc }) + '</a:p></p:txBody></p:sp>');
    yOff += 500000;
  }
  return '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' + shapes.join('') + '</p:spTree></p:cSld></p:sld>';
}

interface SlideContent {
  isHero: boolean; isCenter: boolean; heading: string; subtitle: string; meta: string;
  bullets: string[]; stats: { value: string; label: string }[];
  timelinePoints: { date: string; text: string }[]; quote: string; attribution: string;
  bodyTexts: string[];
}

function buildPptxZip(slideContents: SlideContent[]): Promise<Buffer> {
  const zip = new JSZip(); const n = slideContents.length;
  let ct = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>';
  for (let i = 0; i < n; i++) ct += '<Override PartName="/ppt/slides/slide' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>';
  ct += '</Types>';

  let presRels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>';
  for (let i = 0; i < n; i++) presRels += '<Relationship Id="rId' + (i + 3) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (i + 1) + '.xml"/>';
  presRels += '</Relationships>';

  const sldIds = Array.from({ length: n }, (_: any, i: number) => '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 3) + '"/>').join('');

  zip.file('[Content_Types].xml', ct);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
  zip.file('ppt/presentation.xml', '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="1" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>' + sldIds + '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', presRels);
  zip.file('ppt/slideMasters/slideMaster1.xml', '<?xml version="1.0" encoding="UTF-8"?><p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>');
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>');
  zip.file('ppt/slideLayouts/slideLayout1.xml', '<?xml version="1.0" encoding="UTF-8"?><p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld></p:sldLayout>');
  zip.file('ppt/theme/theme1.xml', '<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Default"><a:themeElements><a:clrScheme name="Default"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1A365D"/></a:dk2><a:lt2><a:srgbClr val="F7FAFC"/></a:lt2><a:accent1><a:srgbClr val="2B6CB0"/></a:accent1><a:accent2><a:srgbClr val="ED8936"/></a:accent2></a:clrScheme><a:fontScheme name="Default"><a:majorFont><a:latin typeface="Helvetica"/></a:majorFont><a:minorFont><a:latin typeface="Helvetica"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>');

  const slidesDir = zip.folder('ppt/slides'); const slidesRelsDir = zip.folder('ppt/slides/_rels');
  for (let i = 0; i < n; i++) {
    const c = slideContents[i]; const bodyElements: string[] = [];
    if (c.subtitle) bodyElements.push(c.subtitle);
    if (c.meta) bodyElements.push(c.meta);
    for (const b of c.bullets) bodyElements.push('• ' + b);
    for (const s of c.stats) bodyElements.push(s.value + ' — ' + s.label);
    for (const tp of c.timelinePoints) bodyElements.push(tp.date + ': ' + tp.text);
    if (c.quote) bodyElements.push('"' + c.quote + '"');
    if (c.attribution) bodyElements.push(c.attribution);
    for (const t of c.bodyTexts) bodyElements.push(t);
    slidesDir!.file('slide' + (i + 1) + '.xml', buildSlideXml(c.heading, bodyElements, c.isHero, c.isCenter));
    slidesRelsDir!.file('slide' + (i + 1) + '.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>');
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Convert HTML slides to PPTX via cheerio text extraction → JSZip PPTX.
 * Gotenberg v7 doesn't have screenshot endpoint — extract text from HTML,
 * build editable PPTX with proper text elements instead of full-slide images.
 */
export async function htmlToPptxViaGotenberg(html: string): Promise<Buffer> {
  const slideRegex = /<section([^>]*)>([\s\S]*?)<\/section>/gi;
  const slides: { classes: string; html: string }[] = [];
  let match;
  while ((match = slideRegex.exec(html)) !== null) slides.push({ classes: match[1], html: match[0] });
  if (slides.length === 0) throw new Error('No <section> elements found in HTML');

  const slideContents: SlideContent[] = slides.map(({ classes, html: slideHtml }) => {
    const $ = cheerio.load(slideHtml, { xml: { xmlMode: false } });
    const isHero = classes.includes('layout-hero');
    const isCenter = classes.includes('center');
    const heading = $('h1').first().text().trim() || $('h2').first().text().trim();
    const subtitle = $('.subtitle').first().text().trim();
    const meta = $('.meta').first().text().trim();
    const bullets: string[] = []; $('li').each((_i: number, el: any) => { const t = $(el).text().trim(); if (t) bullets.push(t); });
    const stats: { value: string; label: string }[] = []; $('.card').each((_i: number, card: any) => { const v = $(card).find('.stat-value').text().trim(); const l = $(card).find('.stat-label').text().trim(); if (v) stats.push({ value: v, label: l }); });
    const timelinePoints: { date: string; text: string }[] = []; $('.point').each((_i: number, pt: any) => { const d = $(pt).find('.date').text().trim(); const t = $(pt).find('.text').text().trim(); if (d || t) timelinePoints.push({ date: d, text: t }); });
    const quote = $('blockquote').first().text().trim();
    const attribution = $('.attribution').first().text().trim();
    const bodyTexts: string[] = []; $('p').each((_i: number, p: any) => { const cls = $(p).attr('class') || ''; if (!cls.includes('subtitle') && !cls.includes('meta') && !cls.includes('muted')) { const t = $(p).text().trim(); if (t && t.length > 10) bodyTexts.push(t); } });
    return { isHero, isCenter, heading, subtitle, meta, bullets, stats, timelinePoints, quote, attribution, bodyTexts };
  });

  return buildPptxZip(slideContents);
}
