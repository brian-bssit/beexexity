/**
 * PPTX/PDF Generator Service — HTML-first generation with JSON fallback.
 *
 * Flow (html, default):  prompt → LLM HTML → Gotenberg screenshots → PptxGenJS → .pptx
 *                         prompt → LLM HTML → Gotenberg Chromium → .pdf
 * Flow (json, fallback): prompt → LLM JSON  → python-pptx service → .pptx
 *                         prompt → LLM JSON  → python-pptx → Gotenberg LibreOffice → .pdf
 *
 * Theme system: 10 CSS Variable-based themes. LLM outputs only <section> elements
 * with theme + layout classes. Node.js injects <head> with full CSS before Gotenberg.
 */
import * as cheerio from 'cheerio';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient } from './inference.service.js';
import { htmlToPptxViaGotenberg, htmlToPdfViaGotenberg } from './gotenberg.service.js';
import { PPTX_THEMES_CSS, VALID_THEMES, VALID_LAYOUTS } from './pptx-themes.js';
import type { ContentJson, GeneratePptxResponse } from '../types/pptx.types.js';

// ═══════════════════════════════════════════════
//  System Prompts
// ═══════════════════════════════════════════════

const HTML_SYSTEM_PROMPT = `You are an elite Presentation Art Director (ex-Apple/Stripe). Create visually stunning, highly dynamic slide decks. NEVER repeat the same layout on consecutive slides. Match the visual theme to the content's tone.

## Output Format
Return ONLY <section> elements. NO <html>, <head>, <body>, or markdown fences. Start directly with <section class="slide ..."> and end with </section>.

## Theme Selection
Analyze the document's tone and industry. Select exactly ONE theme class. Apply it to EVERY <section>:

| Theme | Use For |
|---|---|
| theme-executive | Annual reports, Board of Directors, C-Level, formal policies |
| theme-neon | Tech products, IT architecture, cybersecurity, SaaS pitch |
| theme-minimal | Product design, strategy keynote, portfolio, clean proposals |
| theme-pop | Marketing campaigns, creative pitches, events, social media |
| theme-ledger | Financial reports, credit analysis, audit, banking, investment |
| theme-teal | Healthcare, medical research, clinical protocols, pharma |
| theme-earth | ESG reports, sustainability, CSR, environmental projects |
| theme-pitch | Startup investor pitch, innovation, hackathon, high-energy |
| theme-statute | Legal documents, compliance, regulatory, government, contracts |
| theme-academic | Training materials, onboarding, education, internal memos |

Example: <section class="slide theme-neon layout-bento-3">

## Layout Types — VARY EVERY SLIDE
NEVER use the same layout class on two consecutive slides. Pick the layout that fits the content:

**layout-hero** — Opening cover, section intros, or closing slide. Big title + subtitle. Add .center for closing/thank-you slides. Use a decorative .accent-bar.

**layout-split** — Comparing 2 options, before/after, pros vs cons. Two equal columns.

**layout-bento-3** — 3 key metrics, features, or pillars. Three equal cards in a row. Use .card > .stat-value + .stat-label pattern.

**layout-bento-4** — 4 stats, values, or features. 2×2 card grid. Each card with icon, value, and label.

**layout-timeline** — Chronological events, roadmap, process steps. Vertical timeline with date + description points.

**layout-quote** — Testimonial, key insight, or memorable statement. Large italic blockquote with attribution.

**layout-content** — Standard bullet points. ⚠️ MAXIMUM ONCE per deck. Prefer visual layouts above.

## Component Classes (use inside any layout)
- .card — content container. Add .accent-top for top-border accent. Add .center for centered text.
- .stat-value + .stat-label — large KPI number + caption
- .badge — small inline tag/label
- .icon-lg — large emoji (e.g., <div class="icon-lg">🚀</div>)
- .accent-bar — decorative vertical bar (hero slides)
- .title-line — small accent line under headings
- .muted — secondary/dim text
- .mt-2, .mt-4, .mt-6, .mt-8 — vertical spacing

## Emoji Icons (use for visual cues)
📊 Data/Stats 💰 Finance 🔒 Security ⚡ Speed/Innovation 📈 Growth 🎯 Target/Goal
✅ Success/Complete 🏆 Achievement 💡 Idea/Insight 📋 Process 📅 Timeline 🔍 Analysis
🏢 Corporate 🚀 Launch 🤝 Partnership ⚖ Legal ⚕ Healthcare 🌱 Sustainability

## Few-Shot Examples

Cover slide:
<section class="slide theme-executive layout-hero">
  <div class="hero-content">
    <h1>Annual Report 2026</h1>
    <p class="subtitle">Financial Performance & Strategic Outlook</p>
    <p class="meta">July 2026 • Board of Directors</p>
  </div>
  <div class="accent-bar"></div>
</section>

Stats/metrics slide:
<section class="slide theme-executive layout-bento-3">
  <h2>Key Performance Metrics</h2>
  <div class="title-line"></div>
  <div class="bento-grid">
    <div class="card center accent-top">
      <div class="icon-lg">💰</div>
      <div class="stat-value">$12.4M</div>
      <div class="stat-label">Revenue Q3 2026</div>
      <div class="stat-delta up">↑ 23% YoY</div>
    </div>
    <div class="card center accent-top">
      <div class="icon-lg">📈</div>
      <div class="stat-value">62%</div>
      <div class="stat-label">Gross Margin</div>
      <div class="stat-delta up">↑ 5pp</div>
    </div>
    <div class="card center accent-top">
      <div class="icon-lg">🎯</div>
      <div class="stat-value">98.7%</div>
      <div class="stat-label">SLA Compliance</div>
      <div class="stat-delta up">↑ 0.3pp</div>
    </div>
  </div>
</section>

Timeline slide:
<section class="slide theme-executive layout-timeline">
  <h2>Strategic Roadmap 2026</h2>
  <div class="title-line"></div>
  <div class="track">
    <div class="point"><div class="date">Q1 2026</div><div class="text">Market entry — Indonesia & Singapore</div></div>
    <div class="point"><div class="date">Q2 2026</div><div class="text">Product v2 launch with AI features</div></div>
    <div class="point"><div class="date">Q3 2026</div><div class="text">Series A funding round ($15M target)</div></div>
    <div class="point"><div class="date">Q4 2026</div><div class="text">Regional expansion to 5 new markets</div></div>
  </div>
</section>

Closing slide:
<section class="slide theme-executive layout-hero center">
  <div class="hero-content">
    <h1>Thank You</h1>
    <p class="subtitle">Questions & Discussion</p>
    <p class="meta mt-8">contact@company.com • linkedin.com/company</p>
  </div>
  <div class="accent-bar"></div>
</section>

## Design Rules
1. ALWAYS start with layout-hero (cover) and end with layout-hero.center (closing)
2. NEVER use the same layout on two consecutive slides — vary relentlessly
3. MAXIMUM ONE layout-content (bullet list) per entire deck
4. 5-15 slides total depending on topic depth
5. Cards: use 2-4 per bento slide, keep labels short
6. Every <section> MUST have both theme AND layout classes: class="slide THEME LAYOUT"
7. Well-formed HTML: close all tags, no inline styles, use the CSS classes provided`;

const JSON_SYSTEM_PROMPT = `You are a presentation content architect. Output ONLY valid JSON — no markdown, no explanations.

## Slide Types (use the "type" field exactly)
1. cover           — { "type": "cover", "title": "...", "subtitle"?: "...", "date"?: "...", "presenter"?: "..." }
2. section_divider — { "type": "section_divider", "section_number"?: "01", "title": "..." }
3. content         — { "type": "content", "title": "...", "bullets": [{"text": "...", "level": 0}] }
4. comparison      — { "type": "comparison", "title": "...", "left": {"heading": "...", "points": ["..."]}, "right": {"heading": "...", "points": ["..."]} }
5. chart           — { "type": "chart", "title": "...", "chart_type": "bar"|"line"|"pie", "categories": ["..."], "series": [{"name": "...", "values": [1,2]}], "insight"?: "..." }
6. closing         — { "type": "closing", "title": "...", "subtitle"?: "...", "contact"?: "..." }

## Rules
- Start with cover, end with closing
- 3-5 bullets per content slide
- Use comparison for vs/before-after, chart for data
- 5-20 slides total

## Output Format
{
  "meta": { "title": "Deck Title", "subtitle"?: "...", "presenter"?: "...", "date"?: "..." },
  "slides": [
    { "type": "cover", "title": "Title Slide", "subtitle": "..." },
    { "type": "content", "title": "Key Points", "bullets": [{"text": "...", "level": 0}] },
    { "type": "closing", "title": "Thank You" }
  ]
}

Every slide MUST have "type" set to one of the 6 values above.`;

// ═══════════════════════════════════════════════
//  JSON Validation (fallback path)
// ═══════════════════════════════════════════════

const VALID_SLIDE_TYPES = new Set(['cover', 'content', 'section_divider', 'comparison', 'chart', 'closing']);

function validateContentJson(data: unknown): ContentJson {
  if (!data || typeof data !== 'object') throw new Error('Content JSON must be an object');
  const d = data as Record<string, unknown>;
  if (!d.meta || typeof d.meta !== 'object') throw new Error('meta is required');
  const meta = d.meta as Record<string, unknown>;
  if (!meta.title || typeof meta.title !== 'string') throw new Error('meta.title is required');
  if (!Array.isArray(d.slides) || d.slides.length === 0) throw new Error('slides must be a non-empty array');
  if (d.slides.length > 30) throw new Error('Maximum 30 slides');
  for (let i = 0; i < d.slides.length; i++) {
    const s = d.slides[i] as Record<string, unknown>;
    // Auto-fix null/undefined type (LLM hallucination)
    if (s.type === null || s.type === undefined || s.type === 'undefined' || s.type === 'null') {
      s.type = s.chart_type ? 'chart' : s.bullets ? 'content' : s.left ? 'comparison' : 'content';
    }
    if (!s.type || typeof s.type !== 'string' || !VALID_SLIDE_TYPES.has(s.type)) {
      throw new Error(`Slide ${i}: invalid type '${s.type}' (valid: ${[...VALID_SLIDE_TYPES].join(', ')})`);
    }
    if (!s.title || typeof s.title !== 'string') throw new Error(`Slide ${i}: title required`);
  }
  return data as ContentJson;
}

// ═══════════════════════════════════════════════
//  LLM Helpers
// ═══════════════════════════════════════════════

function parseLLMText(raw: string): string {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:html|json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  return cleaned;
}

// ═══════════════════════════════════════════════
//  HTML Wrapping & Sanitasi
// ═══════════════════════════════════════════════

/** Wrap LLM output (section elements) into full HTML document with theme CSS */
function wrapHtml(bodyContent: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280, height=720">
<style>
${PPTX_THEMES_CSS}
</style>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

/** Extract body content from LLM output — handles both raw <section> and full HTML */
function extractBodyContent(raw: string): string {
  let html = raw.trim();

  // Try to extract from full HTML if LLM ignored instructions
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1].trim();

  // Strip <html>/<head> if present but no body tag
  html = html.replace(/<html[^>]*>|<\/html>|<head[^>]*>[\s\S]*?<\/head>/gi, '');
  html = html.replace(/<!DOCTYPE[^>]*>/i, '');

  return html.trim();
}

// ═══════════════════════════════════════════════
//  HTML Validation (theme + layout diversity)
// ═══════════════════════════════════════════════

interface SlideInfo {
  theme: string | null;
  layout: string | null;
  classes: string[];
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSlides(html: string): ValidationResult {
  const errors: string[] = [];
  const $ = cheerio.load(html, { xml: { xmlMode: false } });

  const slides: SlideInfo[] = [];
  $('[class*="slide"]').each((_, el) => {
    const classAttr = $(el).attr('class') || '';
    const classes = classAttr.split(/\s+/).filter(Boolean);
    const theme = classes.find(c => VALID_THEMES.has(c)) || null;
    const layout = classes.find(c => VALID_LAYOUTS.has(c)) || null;
    slides.push({ theme, layout, classes });
  });

  if (slides.length === 0) {
    return { valid: false, errors: ['No slide sections found. Each slide must have class="slide theme-X layout-Y".'] };
  }

  if (slides.length < 4) {
    errors.push(`Only ${slides.length} slide(s) found. Minimum 4 slides required (cover + 2 body + closing).`);
  }

  // ── Theme consistency ──
  const themes = [...new Set(slides.map(s => s.theme).filter(Boolean))];
  if (themes.length === 0) {
    errors.push('No valid theme class found. Every <section> must have a theme class (e.g. theme-executive, theme-neon). Valid themes: ' + [...VALID_THEMES].join(', '));
  } else if (themes.length > 1) {
    errors.push(`Inconsistent themes: ${themes.join(', ')}. A single presentation must use only ONE theme.`);
  }

  // ── Every slide must have a layout ──
  const missingLayouts = slides.filter(s => !s.layout);
  if (missingLayouts.length > 0) {
    errors.push(`${missingLayouts.length} slide(s) missing layout class. Every slide must have a layout (e.g. layout-hero, layout-bento-3). Valid layouts: ${[...VALID_LAYOUTS].join(', ')}`);
  }

  // ── Layout diversity: no consecutive same layout ──
  for (let i = 1; i < slides.length; i++) {
    if (slides[i].layout && slides[i - 1].layout && slides[i].layout === slides[i - 1].layout) {
      errors.push(`Consecutive duplicate layout: slide ${i + 1} and ${i} both use "${slides[i].layout}". NEVER repeat the same layout on consecutive slides.`);
      break; // one violation is enough
    }
  }

  // ── Content layout max 1 per deck ──
  const contentCount = slides.filter(s => s.layout === 'layout-content').length;
  if (contentCount > 1) {
    errors.push(`layout-content used ${contentCount} times. Maximum ONCE per deck. Use visual layouts (bento, split, timeline) instead.`);
  }

  // ── First slide should be hero (cover) ──
  if (slides[0].layout && slides[0].layout !== 'layout-hero') {
    errors.push(`First slide uses "${slides[0].layout}" — should be layout-hero (cover slide).`);
  }

  // ── Last slide should be hero (closing) ──
  const last = slides[slides.length - 1];
  if (last.layout && last.layout !== 'layout-hero') {
    errors.push(`Last slide uses "${last.layout}" — should be layout-hero (closing/thank-you slide).`);
  }

  return { valid: errors.length === 0, errors };
}

// ═══════════════════════════════════════════════
//  HTML Generation (default path)
// ═══════════════════════════════════════════════

export async function generateHtmlSlides(
  prompt: string,
  modelId?: string,
): Promise<{ html: string; modelUsed: string }> {
  const model = modelId || 'qwen.qwen3-235b-a22b-2507-v1:0';
  const userMessage = { role: 'user' as const, content: [{ text: prompt }] };

  let rawResponse = '';
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    let retryHint = '';
    if (attempt > 0 && lastError) {
      retryHint = `VALIDATION FAILED: ${lastError.message}\n\nFix ALL issues above. Return ONLY <section class="slide THEME LAYOUT"> elements. No markdown fences, no <html>/<head>/<body> tags.`;
    }

    const messages = attempt === 0
      ? [userMessage]
      : [userMessage, { role: 'assistant' as const, content: [{ text: rawResponse }] }, { role: 'user' as const, content: [{ text: retryHint }] }];

    const command = new ConverseCommand({
      modelId: model,
      system: [{ text: HTML_SYSTEM_PROMPT }],
      messages,
      inferenceConfig: { maxTokens: 8192, temperature: attempt === 0 ? 0.4 : 0.2 },
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await bedrockClient.send(command, { abortSignal: controller.signal });
      rawResponse = response.output?.message?.content?.[0]?.text ?? '';

      const rawHtml = parseLLMText(rawResponse);
      const bodyContent = extractBodyContent(rawHtml);

      // Validate: must contain <section class="slide
      if (!/<section[^>]*class=["'][^"']*slide[^"']*["']/i.test(bodyContent)) {
        throw new Error('No slide sections found. Each slide must be: <section class="slide theme-X layout-Y">');
      }

      // Validate: slide count
      const slideCount = (bodyContent.match(/<section[^>]*class=["'][^"']*slide/g) || []).length;
      if (slideCount < 2) {
        throw new Error(`Only ${slideCount} slide(s) found. Minimum 4 slides required.`);
      }

      // Validate: theme consistency + layout diversity
      const validation = validateSlides(bodyContent);
      if (!validation.valid) {
        throw new Error(validation.errors.join(' | '));
      }

      // Wrap with full HTML document + inject theme CSS
      const fullHtml = wrapHtml(bodyContent);

      return { html: fullHtml, modelUsed: model };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === 2) throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('Failed to generate HTML slides');
}

// ═══════════════════════════════════════════════
//  JSON Generation (fallback path)
// ═══════════════════════════════════════════════

export async function generateContentJson(
  prompt: string,
  modelId?: string,
): Promise<{ content: ContentJson; rawJson: string; modelUsed: string }> {
  const model = modelId || 'qwen.qwen3-235b-a22b-2507-v1:0';
  const userMessage = { role: 'user' as const, content: [{ text: prompt }] };

  let rawResponse = '';
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    let retryPrompt = '';
    if (attempt > 0 && lastError) {
      const errMsg = lastError.message;
      if (errMsg.includes('left column required') || errMsg.includes('right column required')) {
        retryPrompt = `ERROR: Comparison slide missing left/right. Must be: {"type":"comparison","title":"...","left":{"heading":"...","points":["..."]},"right":{"heading":"...","points":["..."]}}`;
      } else if (errMsg.includes('invalid type')) {
        retryPrompt = `ERROR: Invalid slide type. Valid: cover, content, section_divider, comparison, chart, closing.`;
      } else {
        retryPrompt = `ERROR: ${errMsg}. Fix and return ONLY valid JSON.`;
      }
    }

    const command = new ConverseCommand({
      modelId: model,
      system: [{ text: JSON_SYSTEM_PROMPT }],
      messages: attempt === 0
        ? [userMessage]
        : [userMessage, { role: 'assistant' as const, content: [{ text: rawResponse }] }, { role: 'user' as const, content: [{ text: retryPrompt }] }],
      inferenceConfig: { maxTokens: 4096, temperature: attempt === 0 ? 0.2 : 0.1 },
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await bedrockClient.send(command, { abortSignal: controller.signal });
      rawResponse = response.output?.message?.content?.[0]?.text ?? '';

      const parsed = JSON.parse(parseLLMText(rawResponse));
      const validated = validateContentJson(parsed);
      return { content: validated, rawJson: rawResponse, modelUsed: model };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === 2) throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('Failed to generate Content JSON');
}

// ═══════════════════════════════════════════════
//  Main Generation Pipeline
// ═══════════════════════════════════════════════

export async function generatePptx(
  prompt: string,
  modelId?: string,
): Promise<GeneratePptxResponse> {
  const safeTitle = prompt.replace(/[^a-z0-9\-_ ]/gi, '').replace(/\s+/g, '-').slice(0, 40) || 'presentation';
  const timestamp = new Date().toISOString().slice(0, 10);

  const { html } = await generateHtmlSlides(prompt, modelId);
  const buffer = await htmlToPptxViaGotenberg(html);
  return { buffer, filename: `${safeTitle}-${timestamp}.pptx` };
}

export async function generatePdf(
  prompt: string,
  modelId?: string,
): Promise<GeneratePptxResponse> {
  const safeTitle = prompt.replace(/[^a-z0-9\-_ ]/gi, '').replace(/\s+/g, '-').slice(0, 40) || 'presentation';
  const timestamp = new Date().toISOString().slice(0, 10);

  const { html } = await generateHtmlSlides(prompt, modelId);
  const buffer = await htmlToPdfViaGotenberg(html);
  return { buffer, filename: `${safeTitle}-${timestamp}.pdf` };
}
