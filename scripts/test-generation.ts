/**
 * Live test: generate HTML slides via Bedrock → validate → wrap.
 * Saves output to docs/assets/test-generation.html for visual inspection.
 *
 * Usage: PROMPT="Laporan keuangan Q3" npx tsx scripts/test-generation.ts
 *        npx tsx scripts/test-generation.ts "Startup pitch deck for AI SaaS"
 */
import { generateHtmlSlides, validateSlides } from '../src/services/pptx-generator.service.js';
import { writeFileSync } from 'fs';

const prompt = process.argv[2] || 'Laporan kinerja perusahaan teknologi untuk Q3 2026. Sertakan metrik revenue, growth, dan timeline ekspansi.';

console.log(`Prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);
console.log('Generating via Bedrock (qwen3-235b)...');
const start = Date.now();

try {
  const { html, modelUsed } = await generateHtmlSlides(prompt);
  const duration = ((Date.now() - start) / 1000).toFixed(1);

  // Quick stat dump
  const slideCount = (html.match(/<section[^>]*class="[^"]*slide/g) || []).length;
  const themeMatch = bodyContent.match(/class="[^"]*theme-(\S+?)(?:\s|")/);
  const theme = themeMatch ? themeMatch[1].replace(/['"]/g, '') : 'unknown';
  const sizeKb = (Buffer.byteLength(html) / 1024).toFixed(1);

  console.log(`✅ ${slideCount} slides · ${theme} · ${sizeKb} KB · ${duration}s · model: ${modelUsed}`);

  // Validate the wrapped HTML
  const bodyContent = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const validation = validateSlides(bodyContent);
  if (validation.valid) {
    console.log('✅ Validation: PASS');
  } else {
    console.log('⚠️  Validation: (post-wrap check)');
    for (const err of validation.errors) console.log(`   - ${err}`);
  }

  const outPath = 'docs/assets/test-generation.html';
  writeFileSync(outPath, html);
  console.log(`📄 ${outPath} — open in browser to inspect`);

  // Also dump raw theme/layout summary
  const layoutMatches = bodyContent.match(/layout-(\S+)/g);
  if (layoutMatches) {
    const layouts = layoutMatches.map(l => l.replace(/['"]/g, ''));
    console.log(`   Layouts: ${layouts.join(' → ')}`);
  }
} catch (err) {
  const duration = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`❌ Failed after ${duration}s`);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
