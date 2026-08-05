import { ContentBuildInput, ContentBlock } from '../types/upload.types.js';

/**
 * Build ordered content blocks for Bedrock Converse API.
 * Order: user prompt text → labeled document texts → document blocks → image blocks.
 *
 * When a document's text extraction returns empty (image-only PDF, etc.),
 * the raw document block is included so the two-stage OCR pipeline
 * can send it to Nova for extraction.
 *
 * Throws if no prompt and no files are provided (empty request).
 */
export function buildContentBlocks(input: ContentBuildInput): ContentBlock[] {
  const { maskedPrompt, documentExtractions, imageBlocks, documentBlocks } = input;

  // Reject empty requests (no prompt + no files)
  const hasDocBlocks = documentBlocks && documentBlocks.length > 0;
  if (!maskedPrompt && documentExtractions.length === 0 && imageBlocks.length === 0 && !hasDocBlocks) {
    throw new Error('At least one input is required: text prompt or file attachment');
  }

  const blocks: ContentBlock[] = [];

  // 1. User's masked text prompt (if present) comes first as a text block
  if (maskedPrompt) {
    blocks.push({ text: maskedPrompt });
  }

  // 2. Each document's masked extracted text is labeled and added as a text block
  for (const doc of documentExtractions) {
    if (doc.text) {
      blocks.push({
        text: `Content from uploaded document '${doc.filename}':\n${doc.text}`,
      });
    }
  }

  // 3. Raw document blocks for OCR fallback (when text extraction was empty)
  if (documentBlocks && documentBlocks.length > 0) {
    blocks.push(...documentBlocks);
  }

  // 4. Image content blocks are appended after all text blocks, in upload order
  blocks.push(...imageBlocks);

  return blocks;
}
