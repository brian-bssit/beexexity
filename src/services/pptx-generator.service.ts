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

Cover (theme-executive, layout-hero):
<section class="slide theme-executive layout-hero">
  <div class="hero-content">
    <h1>Annual Report 2026</h1>
    <p class="subtitle">Financial Performance & Strategic Outlook</p>
    <p class="meta">July 2026 • Board of Directors</p>
  </div>
  <div class="accent-bar"></div>
</section>

Stats (theme-ledger, layout-bento-4 — 4 KPIs):
<section class="slide theme-ledger layout-bento-4">
  <h2>Q3 2026 Financial Highlights</h2>
  <div class="title-line"></div>
  <div class="bento-grid">
    <div class="card center accent-top"><div class="icon-lg">💰</div><div class="stat-value">$12.4M</div><div class="stat-label">Revenue</div><div class="stat-delta up">↑ 23% YoY</div></div>
    <div class="card center accent-top"><div class="icon-lg">📊</div><div class="stat-value">62%</div><div class="stat-label">Gross Margin</div><div class="stat-delta up">↑ 5pp</div></div>
    <div class="card center accent-top"><div class="icon-lg">👥</div><div class="stat-value">2,847</div><div class="stat-label">Active Users</div><div class="stat-delta up">↑ 18% QoQ</div></div>
    <div class="card center accent-top"><div class="icon-lg">📉</div><div class="stat-value">$1.82</div><div class="stat-label">CAC Payback</div><div class="stat-delta down">↓ 12%</div></div>
  </div>
</section>

Comparison (theme-neon, layout-split — tech migration before/after):
<section class="slide theme-neon layout-split">
  <h2>Monolith vs Microservices</h2>
  <div class="title-line"></div>
  <div class="split-grid">
    <div class="split-left"><h3>🔴 Legacy Monolith</h3><ul><li>Single point of failure — 3 outages/month</li><li>Deploy cycle: 2 weeks</li><li>Scale: vertical only (16 vCPU max)</li><li>Tech debt: 40% of sprint capacity</li></ul></div>
    <div class="split-right"><h3>🟢 Microservices (Target)</h3><ul><li>Isolated failure domains — 99.99% uptime</li><li>Deploy cycle: 4 hours</li><li>Scale: horizontal (auto-scale per service)</li><li>Tech debt: 10% of sprint capacity</li></ul></div>
  </div>
</section>

Quote/testimonial (theme-pitch, layout-quote — investor insight):
<section class="slide theme-pitch layout-quote">
  <h2>What Our Investors Say</h2>
  <div class="title-line"></div>
  <blockquote>"The AI-first approach to document processing is not just innovative — it's category-defining. This team understands the enterprise."</blockquote>
  <p class="attribution">Sarah Chen, Partner • Accel Ventures</p>
  <p class="meta mt-4">Series A Lead Investor • $15M Round</p>
</section>

Timeline (theme-minimal, layout-timeline — product roadmap):
<section class="slide theme-minimal layout-timeline">
  <h2>Product Roadmap 2026</h2>
  <div class="title-line"></div>
  <div class="track">
    <div class="point"><div class="date">Q1</div><div class="text">Core API v2 — multi-tenant, rate limiting, SLA 99.9%</div></div>
    <div class="point"><div class="date">Q2</div><div class="text">AI Copilot — inline document Q&A, semantic search</div></div>
    <div class="point"><div class="date">Q3</div><div class="text">Enterprise SSO — SAML/OIDC, RBAC, audit log export</div></div>
    <div class="point"><div class="date">Q4</div><div class="text">Global expansion — EU (Frankfurt), APAC (Singapore)</div></div>
  </div>
</section>

Closing (theme-pitch, layout-hero center):
<section class="slide theme-pitch layout-hero center">
  <div class="hero-content">
    <h1>Let's Build Together</h1>
    <p class="subtitle">Join 200+ enterprises processing 50M+ documents monthly</p>
    <p class="meta mt-8">hello@company.com • linkedin.com/company/name</p>
  </div>
  <div class="accent-bar"></div>
</section>

## Content-Adaptive Layout Rules
MATCH the layout to what the content actually needs — do NOT force content into random layouts:

| Content Contains | Best Layout | Why |
|---|---|---|
| 2-3 key metrics, pillars, or features | layout-bento-3 | Three cards naturally highlight a triad |
| 4 stats, KPIs, or quadrants | layout-bento-4 | 2×2 grid for balanced comparison |
| Chronological events, steps, roadmap | layout-timeline | Temporal sequence = timeline |
| Before/after, pros/cons, option A vs B | layout-split | Side-by-side comparison |
| Testimonial, key insight, memorable quote | layout-quote | Large text = emphasis and memorability |
| Standard explanation or bullet list | layout-content | ⚠️ ONLY 1x per deck, last resort |

## Layout Rhythm — Pick One Pattern
Do NOT randomly shuffle layouts. Pick ONE rhythm below that fits the content type. Adapt the number of slides (5-15) based on depth.

**Report Rhythm** (annual reports, financial reviews, audit):
hero → bento-4 → bento-3 → timeline → quote → hero.center

**Pitch Rhythm** (startup pitch, product launch, proposal):
hero → bento-3 → split → quote → bento-4 → hero.center

**Strategy Rhythm** (strategic plan, transformation, roadmap):
hero → timeline → split → bento-3 → quote → hero.center

**Training Rhythm** (onboarding, education, SOP):
hero → bento-3 → timeline → split → content → hero.center

**Analysis Rhythm** (research, competitive analysis, due diligence — shorter, data-dense):
hero → bento-4 → split → timeline → hero.center

Each rhythm is a SUGGESTION — adapt by adding/removing slides based on actual content volume. If the content has no testimonial, skip the quote slide. If it has 5 metrics, use bento-4 instead of bento-3. The key: never repeat a layout on consecutive slides.

## Design Rules
1. ALWAYS start with layout-hero (cover) and end with layout-hero.center (closing)
2. NEVER use the same layout on two consecutive slides
3. MAXIMUM ONE layout-content (bullet list) per entire deck — prefer visual layouts
4. 5-15 slides total depending on topic depth
5. Cards: use 2-4 per bento slide, keep labels short, always include stat-value + stat-label
6. Every <section> MUST have both theme AND layout classes: class="slide THEME LAYOUT"
7. Well-formed HTML: close all tags, no inline styles, use the CSS classes provided
8. CRITICAL: Let the content dictate the structure. If the user mentions 3 pillars → bento-3. Processes with dates → timeline. Comparing options → split. Do NOT invent content — extract and organize what the user provided.`;

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

// ── Document System Prompt (PDF — NOT slides) ──

const DOCUMENT_SYSTEM_PROMPT = `You are a senior technical writer and document designer. Create professional, well-structured documents suitable for PDF export. Output clean, semantic HTML — NOT slide sections.

## Output Format
Return a complete HTML document inside <article> tags. NO <section class="slide">, NO theme classes, NO layout classes. This is a DOCUMENT, not a presentation.

Use these HTML elements:
- <article> — wraps the entire document
- <h1> — document title (once, at top)
- <h2> — major section headings
- <h3> — sub-section headings
- <p> — paragraphs (12-16 words per sentence max, vary sentence length)
- <ul> / <ol> — bullet and numbered lists
- <table> — data tables with <thead> and <tbody>
- <blockquote> — key quotes or callouts
- <hr> — section dividers
- <strong> / <em> — emphasis
- <code> — technical terms, numbers, codes

## Document Structure
Follow this structure — adapt section count to content depth:

1. **Title** (<h1>) — document title + optional subtitle line
2. **Executive Summary** (<h2>) — 2-4 sentence overview of key findings
3. **Body Sections** (<h2> each) — organized by topic, 2-6 sections
4. **Data Tables** (<table>) — wherever data comparison is needed
5. **Conclusion / Recommendations** (<h2>) — actionable next steps

## Styling Classes (use these sparingly for document polish)
- .cover — title page wrapper
- .summary-box — bordered box for executive summary (gray background, padding)
- .data-table — wrap around <table> for horizontal scroll
- .callout — important note/warning box (left border accent)
- .page-break — force new page before this element
- .text-sm — smaller text for footnotes, disclaimers
- .text-muted — secondary/gray text

## Design Rules
1. Professional, clean, minimal. This is a business document, not marketing material.
2. Use tables for data comparison — never use bullet lists for tabular data.
3. Maximum 3 levels of headings (h1 → h2 → h3).
4. Keep paragraphs focused — one idea per paragraph.
5. Include a .page-break before major sections for clean PDF pagination.
6. Write in the SAME LANGUAGE as the user's prompt.
7. Be comprehensive but concise — prefer depth over breadth.
8. Output ONLY valid HTML inside <article> tags. NO markdown, NO code fences.
9. Always use <article class="document"> as the root element.`;

// ── Generate HTML Document (for PDF) ──

export async function generateHtmlDocument(
  prompt: string,
  modelId?: string,
): Promise<{ html: string; modelUsed: string }> {
  const model = modelId || 'qwen.qwen3-235b-a22b-2507-v1:0';
  const userMessage = { role: 'user' as const, content: [{ text: prompt }] };

  let rawResponse = '';
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    let retryPrompt = '';
    if (attempt > 0 && lastError) {
      retryPrompt = `ERROR: ${lastError.message}. Fix and return ONLY valid HTML.`;
    }

    const command = new ConverseCommand({
      modelId: model,
      system: [{ text: DOCUMENT_SYSTEM_PROMPT }],
      messages: attempt === 0
        ? [userMessage]
        : [userMessage, { role: 'assistant' as const, content: [{ text: rawResponse }] }, { role: 'user' as const, content: [{ text: retryPrompt }] }],
      inferenceConfig: { maxTokens: 16384, temperature: attempt === 0 ? 0.3 : 0.1 },
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await bedrockClient.send(command, { abortSignal: controller.signal });
      rawResponse = response.output?.message?.content?.[0]?.text ?? '';

      const cleaned = parseLLMText(rawResponse);

      // Validate: must contain <article> tag
      if (!/<article/i.test(cleaned)) {
        throw new Error('Document must be wrapped in <article class="document"> tags');
      }

      // Extract article content, strip outer HTML if present
      let bodyContent = cleaned;
      const articleMatch = bodyContent.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
      if (articleMatch) bodyContent = articleMatch[1];
      // Strip <html>/<head>/<body> if LLM ignored instructions
      bodyContent = bodyContent.replace(/<html[^>]*>|<\/html>|<head[^>]*>[\s\S]*?<\/head>|<body[^>]*>|<\/body>/gi, '');

      // Wrap in full HTML with document CSS
      const fullHtml = wrapDocumentHtml(bodyContent);

      return { html: fullHtml, modelUsed: model };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === 2) throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('Failed to generate document HTML');
}

/** Wrap document article content into full HTML with document-appropriate CSS */
function wrapDocumentHtml(bodyContent: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 2cm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Georgia', 'Times New Roman', serif; color: #1a1a1a; line-height: 1.7; font-size: 12pt; max-width: 100%; }
  article.document { padding: 0; }
  h1 { font-size: 24pt; font-weight: 700; margin-bottom: 0.25cm; color: #1a365d; border-bottom: 3px solid #2b6cb0; padding-bottom: 0.3cm; }
  h2 { font-size: 16pt; font-weight: 600; margin-top: 1.2cm; margin-bottom: 0.4cm; color: #2b6cb0; }
  h3 { font-size: 13pt; font-weight: 600; margin-top: 0.8cm; margin-bottom: 0.3cm; color: #2d3748; }
  p { margin-bottom: 0.35cm; text-align: justify; }
  ul, ol { margin: 0.3cm 0 0.5cm 1.2cm; }
  li { margin-bottom: 0.15cm; }
  table { width: 100%; border-collapse: collapse; margin: 0.5cm 0; font-size: 10pt; }
  th { background: #1a365d; color: #fff; padding: 8px 10px; text-align: left; font-weight: 600; }
  td { padding: 6px 10px; border-bottom: 1px solid #e2e8f0; }
  tr:nth-child(even) td { background: #f7fafc; }
  blockquote { border-left: 4px solid #2b6cb0; padding: 0.3cm 0.6cm; margin: 0.5cm 0; color: #4a5568; font-style: italic; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 0.6cm 0; }
  code { font-family: 'SF Mono', Monaco, monospace; background: #edf2f7; padding: 2px 6px; border-radius: 3px; font-size: 9pt; }
  .cover { text-align: center; padding-top: 4cm; page-break-after: always; }
  .cover h1 { font-size: 28pt; border-bottom: none; }
  .summary-box { background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.6cm 0.8cm; margin: 0.5cm 0; }
  .callout { border-left: 4px solid #ed8936; background: #fffaf0; padding: 0.4cm 0.6cm; margin: 0.5cm 0; }
  .page-break { page-break-before: always; }
  .text-sm { font-size: 9pt; color: #718096; }
  .text-muted { color: #718096; }
  .data-table { overflow-x: auto; }
</style>
</head>
<body>
<article class="document">
${bodyContent}
</article>
</body>
</html>`;
}

// ── Generate HTML Slides (for PPTX) ──

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
  const safeTitle = prompt.replace(/[^a-z0-9\-_ ]/gi, '').replace(/\s+/g, '-').slice(0, 40) || 'document';
  const timestamp = new Date().toISOString().slice(0, 10);

  const { html } = await generateHtmlDocument(prompt, modelId);
  const buffer = await htmlToPdfViaGotenberg(html, 'document');
  return { buffer, filename: `${safeTitle}-${timestamp}.pdf` };
}
