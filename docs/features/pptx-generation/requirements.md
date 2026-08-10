# Requirements: PPTX Generation with Template-Based Design

## Overview
PPTX/PDF generation via LLM content + professional template. User describes what they want, LLM outputs structured JSON, python-pptx fills a designer-made template → downloadable .pptx file. Manual mode only (no routing engine).

## Glossary
- **Template**: .pptx file with Slide Masters designed by a human. Contains layouts (cover, content, divider, chart, table, CTA) with pre-styled placeholders, fonts, colors, backgrounds.
- **Content JSON**: Structured output from LLM — slide types + text content. Zero design awareness.
- **python-pptx service**: Tiny Python Cloud Run service that opens template, fills placeholders, returns .pptx.

## Constraints
- GCP `asia-southeast2` only. No new AWS resources.
- Manual model selection only (user preference). LLM call via existing Bedrock Converse API.
- python-pptx service in same GCP project, internal auth via IAM.
- No async queue for MVP — synchronous generation. Add async later if >30s.

## Requirements

### Req 1: PPTX Generation Endpoint
**User Story:** User sends prompt describing a presentation → receives .pptx file.

**AC:**
- `POST /api/v1/generate/pptx` accepts `{ prompt, template? }` (template optional, default "corporate")
- WHEN prompt describes presentation content THEN LLM outputs Content JSON (valid, parseable, non-empty slides)
- WHEN Content JSON is valid THEN python-pptx generates .pptx with template styling
- WHEN generation succeeds THEN client receives `application/vnd.openxmlformats-officedocument.presentationml.presentation` with `Content-Disposition: attachment`
- WHEN LLM JSON is malformed THEN return 422 with parse error details, retry prompt suggests fixing format issues

### Req 2: Template Design (Human)
**User Story:** Designer creates a polished .pptx template with Slide Masters.

**AC:**
- Template has at minimum 6 slide layouts: Cover, Content (text+bullets), Section Divider, Two-Column Comparison, Chart/Data, Closing/CTA
- Each layout has named shapes with consistent naming convention (`ph_title`, `ph_body`, `ph_subtitle`, etc.)
- Template uses brand colors, custom fonts (embedded), geometric decorations, proper spacing
- Template file stored in GCS bucket `beexexity-templates`
- Initial template: "corporate" — navy+gold professional theme

### Req 3: Python PPTX Service
**User Story:** Internal microservice takes Content JSON + template name → returns .pptx binary.

**AC:**
- `POST /generate` accepts `{ template, slides }` JSON
- WHEN valid input THEN opens template from local cache, fills placeholders per slide type, returns .pptx Buffer
- WHEN template not found THEN 404
- WHEN input validation fails THEN 400 with field-level errors
- Response time <10s for 20-slide deck
- Deployed as Cloud Run service in `asia-southeast2`, min 0 instances (scale-to-zero)
- Internal-only (no public endpoint), IAM-authenticated calls from main app

### Req 4: LLM System Prompt (Content JSON Schema)
**User Story:** LLM outputs strictly-typed JSON describing slide content without design decisions.

**AC:**
- System prompt includes: available slide types, JSON schema with field descriptions, design best practices (when to use which layout), 1 example per slide type
- LLM outputs ONLY valid JSON (instructed to avoid markdown wrapping)
- Parser handles: ```json fences (strip if present), trailing commas (auto-fix before JSON.parse), markdown inside JSON values (preserved)

### Req 5: File Download & Cleanup
**User Story:** Generated file is downloadable and doesn't accumulate.

**AC:**
- Response includes `Content-Disposition: attachment; filename="presentation-{timestamp}.pptx"`
- File generated in-memory (Buffer), no persistent storage
- No cleanup needed — memory released after response
