/**
 * Generate static HTML preview of all 10 PPTX themes.
 * Usage: npx tsx scripts/generate-theme-preview.ts
 * Output: docs/assets/theme-preview.html (open in browser)
 */
import { PPTX_THEMES_CSS } from '../src/services/pptx-themes.js';
import { writeFileSync } from 'fs';

// Sample slides per theme
const sampleSlides: Record<string, string[]> = {
  'theme-executive': [
    `<section class="slide theme-executive layout-hero">
  <div class="hero-content"><h1>Annual Report 2026</h1><p class="subtitle">Financial Performance & Strategic Outlook</p><p class="meta">July 2026 · Board of Directors</p></div>
  <div class="accent-bar"></div></section>`,
    `<section class="slide theme-executive layout-bento-3">
  <h2>Key Metrics</h2><div class="title-line"></div>
  <div class="bento-grid">
    <div class="card center accent-top"><div class="icon-lg">💰</div><div class="stat-value">$12.4M</div><div class="stat-label">Revenue Q3</div><div class="stat-delta up">↑ 23% YoY</div></div>
    <div class="card center accent-top"><div class="icon-lg">📈</div><div class="stat-value">62%</div><div class="stat-label">Gross Margin</div><div class="stat-delta up">↑ 5pp</div></div>
    <div class="card center accent-top"><div class="icon-lg">🎯</div><div class="stat-value">98.7%</div><div class="stat-label">SLA Compliance</div><div class="stat-delta up">↑ 0.3pp</div></div>
  </div></section>`,
    `<section class="slide theme-executive layout-hero center">
  <div class="hero-content"><h1>Thank You</h1><p class="subtitle">Questions & Discussion</p><p class="meta mt-8">contact@company.com</p></div>
  <div class="accent-bar"></div></section>`,
  ],
  'theme-neon': [
    `<section class="slide theme-neon layout-hero">
  <div class="hero-content"><h1>Zero Trust Architecture</h1><p class="subtitle">Cloud Security Framework v2.0</p><p class="meta">2026 · CISO Office</p></div>
  <div class="accent-bar"></div></section>`,
    `<section class="slide theme-neon layout-bento-3">
  <h2>Security Posture</h2><div class="title-line"></div>
  <div class="bento-grid">
    <div class="card center"><div class="icon-lg">🔒</div><div class="stat-value">99.99%</div><div class="stat-label">Uptime SLA</div></div>
    <div class="card center"><div class="icon-lg">⚡</div><div class="stat-value">&lt;5ms</div><div class="stat-label">Latency P99</div></div>
    <div class="card center"><div class="icon-lg">🛡</div><div class="stat-value">0</div><div class="stat-label">Critical CVEs</div></div>
  </div></section>`,
    `<section class="slide theme-neon layout-hero center">
  <div class="hero-content"><h1>Secure by Design</h1><p class="subtitle">security@company.com</p></div>
  <div class="accent-bar"></div></section>`,
  ],
  'theme-minimal': [
    `<section class="slide theme-minimal layout-hero">
  <div class="hero-content"><h1>Product Design v3</h1><p class="subtitle">Redefining the user experience</p><p class="meta">Design Review · July 2026</p></div>
  <div class="accent-bar"></div></section>`,
    `<section class="slide theme-minimal layout-split">
  <h2>Before vs After</h2>
  <div class="split-left"><div class="card center"><div class="icon-lg">😰</div><h3>Complex</h3><p class="muted mt-2">7 steps · 3 min avg</p></div></div>
  <div class="split-right"><div class="card center"><div class="icon-lg">✨</div><h3>Simple</h3><p class="muted mt-2">2 steps · 15 sec avg</p></div></div></section>`,
    `<section class="slide theme-minimal layout-hero center">
  <div class="hero-content"><h1>Simplicity</h1><p class="subtitle">design@company.com</p></div>
  <div class="accent-bar"></div></section>`,
  ],
};

// Generic sample for remaining themes
function makeSamples(theme: string, label: string): string[] {
  return [
    `<section class="slide ${theme} layout-hero">
  <div class="hero-content"><h1>${label}</h1><p class="subtitle">Sample Presentation Deck</p><p class="meta">July 2026</p></div>
  <div class="accent-bar"></div></section>`,
    `<section class="slide ${theme} layout-bento-3">
  <h2>Key Highlights</h2><div class="title-line"></div>
  <div class="bento-grid">
    <div class="card center accent-top"><div class="icon-lg">📊</div><div class="stat-value">42%</div><div class="stat-label">Metric Alpha</div></div>
    <div class="card center accent-top"><div class="icon-lg">🎯</div><div class="stat-value">1.8x</div><div class="stat-label">Metric Beta</div></div>
    <div class="card center accent-top"><div class="icon-lg">✅</div><div class="stat-value">95%</div><div class="stat-label">Metric Gamma</div></div>
  </div></section>`,
    `<section class="slide ${theme} layout-hero center">
  <div class="hero-content"><h1>Thank You</h1><p class="subtitle">Questions?</p></div>
  <div class="accent-bar"></div></section>`,
  ];
}

const remaining: Record<string, string> = {
  'theme-pop': 'Vibrant Pop — Marketing',
  'theme-ledger': 'Emerald Ledger — Finance',
  'theme-teal': 'Clinical Teal — Healthcare',
  'theme-earth': 'Eco Earth — Sustainability',
  'theme-pitch': 'Startup Pitch — Innovation',
  'theme-statute': 'Statute Burgundy — Legal',
  'theme-academic': 'Academic Bright — Education',
};

let allSlides = '';
for (const [theme, slides] of Object.entries(sampleSlides)) {
  allSlides += `\n<!-- ═══ ${theme} ═══ -->\n${slides.join('\n')}\n`;
}
for (const [theme, label] of Object.entries(remaining)) {
  allSlides += `\n<!-- ═══ ${theme} ═══ -->\n${makeSamples(theme, label).join('\n')}\n`;
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280">
<title>PPTX 10 Themes — Visual Preview</title>
<style>
/* === Reset for preview === */
html { background: #1a1a2e; }
body { margin: 0; padding: 40px 20px; }

/* === Theme label badge === */
.theme-label { text-align: center; margin: 60px 0 16px 0; }
.theme-label:first-child { margin-top: 0; }
.theme-label span { font-family: system-ui, sans-serif; font-size: 14px; font-weight: 600;
  color: #a0aec0; letter-spacing: 0.5px; text-transform: uppercase; }

/* === Slide container === */
.slide-wrapper { display: flex; justify-content: center; margin-bottom: 16px; }
.slide { margin: 0; box-shadow: 0 8px 40px rgba(0,0,0,.5); flex-shrink: 0; }

/* === Inject theme CSS === */
${PPTX_THEMES_CSS}
</style>
</head>
<body>
${allSlides
  .replace(/<section class="slide (theme-\S+) (layout-\S+)/g,
    (_, theme, layout) => `</div>\n<div class="theme-label"><span>${theme} · ${layout}</span></div>\n<div class="slide-wrapper"><section class="slide ${theme} ${layout}`)
  .replace(/^<\/div>\n/, '')}
</div>
</body>
</html>`;

const outPath = 'docs/assets/theme-preview.html';
writeFileSync(outPath, html);
console.log(`✅ ${outPath} — ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
console.log('   → Open in browser to inspect all 10 themes (30 slides)');
