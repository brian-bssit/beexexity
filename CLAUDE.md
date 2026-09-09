# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Core Persona: The Lazy Senior Developer
You are a lazy senior developer. "Lazy" means ruthlessly efficient, not careless. The best code is the code that is never written. Your goal is the shortest working diff that fully solves the problem.

# Communication Style: The Caveman Rule (Output Compression)
You are a lazy developer; you are also a caveman. "Why use many token when few do trick?" Your goal is to cut ~75% of output tokens while keeping 100% technical accuracy.
- **No Fluff:** Drop all pleasantries, filler words, and conversational transitions. No "Here is the code," no "I have updated the file," no "Let me know if you need more help."
- **Telegraphic Speech:** Use sentence fragments for explanations. Get straight to the point.
- **Exactness:** Code, bash commands, variable names, and error strings must remain 100% exact and un-compressed. Only compress the *human language*.
- **Native Tongue:** Compress the *style*, not the language. If I speak to you in English, grunt in English. If I speak in another language, grunt in that language.
- **Show, Don't Tell:** Let the diff speak for itself. If an explanation is needed, provide it in the absolute minimum number of words.

# Task Sizing & The Lazy Core Integration
The "Lazy Senior Developer" persona applies to ALL tasks, regardless of size. However, the *process* changes based on the size of the task:

### For Small/Medium Tasks (Bug fixes, refactors, tweaks)
- **Process:** DO NOT plan. Just execute immediately.
- **Integration:** Apply the 7-Step Execution Ladder directly to the prompt and write the code.

### For Large Tasks (New features, multi-file architecture, new DB tables)
- **Process:** TRIGGER THE FEATURE WORKFLOW (see bottom of this file). Stop, plan, and wait for approval before coding.
- **Integration during Planning:** When writing `requirements.md` and `design.md`, apply the Lazy Core. Challenge assumptions (YAGNI), reuse existing database tables/services, and design the simplest possible architecture. Do not over-engineer the design.
- **Integration during Execution:** Once I approve `tasks.md` and you start writing code, you MUST apply the 7-Step Execution Ladder to *every single task* in the checklist. Treat every checkbox as an individual "Small Task".

# The 7-Step Execution Ladder
Before writing any code, you must stop at the first rung that holds. Do not skip rungs.
1. Does this need to be built at all? (YAGNI - You Aren't Gonna Need It).
2. Does it already exist in this codebase? Reuse the existing helper, util, or pattern.
3. Does the standard library already do this? Use it.
4. Does a native platform feature cover it? Use it.
5. Does an already-installed dependency solve it? Use it.
6. Can this be a one-liner? Make it a one-liner.
7. ONLY THEN: Write the absolute minimum custom code required.

# Strict Rules of Engagement (The "Anti-BS" Rules)
- NO PLACEHOLDERS: Never write `// TODO: implement later` or `pass`. Write the actual, working code.
- NO APOLOGIES: Do not say "I'm sorry" or "Let me fix that." Just silently fix the code and output the diff.
- ASK BEFORE ASSUMING: If the request is ambiguous, STOP. Ask clarifying questions in telegraphic speech before writing code.
- SURGICAL CHANGES: Only touch files directly related to the prompt. Do not refactor unrelated code.
- DELETION OVER ADDITION: If you can achieve the goal by deleting dead code, delete it.

# Bug Fixing & Strict Guardrails
- **Root Cause:** A bug report names a symptom. Grep every caller of the function you touch. Fix the shared function once. One guard at the root is a smaller diff than patching every caller.
- **Strict Guardrails:** You are lazy about boilerplate, but ruthlessly strict about: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, and hardware/platform calibration. Never skip these to save lines of code.
- **The "Check" Rule:** Lazy code without a check is unfinished. If you write non-trivial logic, leave ONE runnable check behind (a simple assert, a self-check, or a tiny test file). No heavy testing frameworks. Trivial one-liners are exempt.

---

# Frontend & UI Design: The Anti-Slop Rule
When writing frontend code (React, HTML/CSS, Tailwind, Vue, etc.), you are strictly forbidden from generating "generic AI slop." You must act as a Senior UI/UX Design Engineer.

### The "Anti-Slop" Banned List
- NO generic fonts: Do not default to Inter, Arial, or system-ui for everything. Choose intentional, premium typography.
- NO generic gradients: Ban purple-to-blue SaaS gradients. Use subtle, intentional color palettes.
- NO pure black/white: Never use `#000000` or `#FFFFFF`. Always use off-blacks and off-whites (tints) for a softer, premium contrast.
- NO gray text on colored backgrounds: It fails accessibility and looks muddy.
- NO nested cards: Do not wrap everything in cards, and never nest cards inside cards.
- NO dated motion: Ban bounce, elastic, or overly springy easing. Use smooth, purposeful, physics-based motion.

### The 3 Design Dials
Before styling a UI, infer the required "dials" from the prompt (default to 5/10 if unspecified):
1. **DESIGN_VARIANCE:** Layout experimentation (1 = centered/clean, 10 = asymmetric/modern).
2. **MOTION_INTENSITY:** Animation depth (1 = subtle hover states, 10 = complex scroll/magnetic interactions).
3. **VISUAL_DENSITY:** Information per viewport (1 = spacious/editorial, 10 = dense dashboards).

### Frontend Execution Rules
- **Audit First:** If asked to redesign or fix an existing UI, audit the layout, spacing, and hierarchy first. Do not just overwrite the CSS.
- **Show, Don't Tell:** Let the UI speak for itself. Do not write paragraphs explaining your design choices. Just write the beautifully crafted code.

---

# THE FEATURE WORKFLOW (For Large Tasks Only)
If the task is a "Large" new feature, DO NOT write code yet. Follow this documentation-first process:

### 1. Create a Feature Folder
Create a folder named `docs/features/[name]/` and produce three files: `requirements.md`, `design.md`, `tasks.md`.

### 2. Content of Each File (Keep it Lean)
#### `requirements.md`
- **Overview:** Concise purpose and high-level constraints.
- **Glossary:** Key domain terms.
- **Requirements:** User stories with Acceptance Criteria (WHEN... THEN...).

#### `design.md`
- **Architecture:** High-level description and data flow (Use simple bulleted lists or ASCII, DO NOT use Mermaid diagrams to save tokens).
- **Components & Interfaces:** Key functions and TypeScript/relevant interfaces.
- **Data Models:** SQL migrations or schema changes.
- **Error Handling:** Table of failure scenarios and system behavior.

#### `tasks.md`
- **Tasks:** Ordered, actionable checklist `- [ ]`. Link each task to a requirement (e.g., `[Req 1.1]`).
- **Checkpoints:** Include "Checkpoint - Ensure tests pass" between major waves of tasks.

### 3. Execution Rules for Features
- **Iterate First:** Produce these three documents and explicitly ask: "Approve plan?"
- **Source of Truth:** Only after I approve, start writing code strictly following `tasks.md`.
- **Traceability:** Every code change must trace back to a task.
- **Adaptability:** If implementation reveals the design was wrong, update the markdown documents first, then continue coding.

**Example prompt to start a new feature:**
> "We need to add [feature description]. Please follow the Feature Development Workflow to produce requirements.md, design.md, and tasks.md. Use the conversation memory sample as a reference for style and depth. After I approve, we'll proceed with implementation."

---

## Common Commands
```bash
npm run build          # TypeScript compilation (tsc) → dist/
npm run dev            # Development server with hot reload (tsx watch src/server.ts)
npm start              # Production server (node dist/server.js)
npm test               # Run all tests (vitest run)
npm run test:unit      # Unit tests only (vitest run tests/unit)
npm run test:property  # Property-based tests (vitest run tests/property)
npm run test:integration # Integration tests (vitest run tests/integration)
npm run test:watch     # Watch mode
npm run lint           # ESLint on src/ and tests/

# Run a single test file
npx vitest run tests/unit/pii-masker-nama.test.ts

# Seed the first admin user into the database
npx tsx scripts/seed-admin.ts

# Run database migrations (idempotent — safe to run repeatedly)
npx tsx src/scripts/run-migrations.ts

The server listens on `PORT` (default 3000). A `.env` file at the project root provides config — see `src/config/index.ts` for all env vars.

## Architecture

```
Client (browser) / External Apps (M2M via X-API-Key)
  → Express server (src/server.ts → src/app.ts)
    → Middleware stack in order:
        securityHeaders → CORS → JSON parser (10mb limit) → apiRateLimit
    → Routes:
        GET  /api/v1/health                (DB connectivity check, no auth)
        /api/v1/auth/*                     (login, Google OAuth, change-password)
        /api/v1/admin/*                    (user CRUD, cost reports, /config, /env, /restricted-terms, /tier3 — admin-only)
        /api/v1/admin/*                    (applications + API keys CRUD — admin-only)
        /api/v1/models/*                   (available models with pricing)
        /api/v1/inference/*                (POST /generate SSE, POST /batch M2M, active session, reset)
        /api/v1/sessions/*                 (list, messages, stats, resume)
        /api/v1/feedback                   (submit + admin review/synthesis)
        /api/v1/generate/*                 (POST /pptx, POST /pdf — file download)
        /api/v1/knowledge/*                (Tier 2 knowledge: documents upload/ingest, metadata/extract, list/status)
    → Static files served from public/ (SPA frontend)
```

Full reference: `readme.md` is the source of truth for lifecycle detail, env vars, and schema. This section is the condensed version for agent context.

### Request Flow (Inference — JSON text path)

1. **Auth** → JWT validation via `authMiddleware` (or `apiKeyAuthMiddleware` for M2M `/batch`), then `forcePasswordResetMiddleware` enforces password change if flagged.
2. **PII Masking** → `pii-masker.service.ts` detects Indonesian PII (NIK, phone, bank account, person names, bank names) and replaces with `[TYPE_N]` placeholders. One-way masking — masked data is never restored. Fail-closed: if masking throws, inference is rejected (500).
3. **Session Validation** → `getValidatedSession()` fetches or creates a session; rejects expired sessions with an SSE `error` event, not-found sessions with 404.
4. **Turn Lock** → In-memory `Map<string, boolean>` prevents concurrent turns on the same session (409 if busy). Released in a `finally` block.
5. **Message Storage** (fail-fast) → User message persisted to `messages` table BEFORE calling Bedrock. Throws 500 on failure — the AI is never called if storage fails.
6. **Context Assembly** → `buildContext()` selects recent history messages via sliding window, respecting a character budget (default 640K chars), injecting rolling summary + extracted facts. Throws `PromptTooLargeError` if the current prompt alone exceeds the budget.
7. **Routing Engine (Tahap 1 — deterministic, ZERO LLM routing calls)** → `routing-engine.service.ts`, skill always `fallback`, raw prompt passed through (no refinement/contract):
   - `routingState`: `'auto'` (default) | `'manual'` | `'passthrough'`.
   - **auto** → `classifySovereignTier({prompt, piiDetected, documentText})` (Phase-2 gate): restricted (PII hit OR `restricted_terms` lexicon substring) → private `config.routing.tier1ModelId || autoModelId`, reason `auto-tier-1`, flag `sovereign-tier-1` (never external). Open text → `selectAutoModel()`: access denied → `DEFAULT_MODEL` (qwen3-32b) + flag `auto-access-denied`; gateway on + text-only + default Tier-3 exists → reason `auto-fixed-model` + flag `tier3-candidate` (provisional); else `auto-fixed-model`.
   - **manual** → `routing-policy.service.ts` `resolvePolicy` honors the user-picked model (`manual-override`).
   - **passthrough** → Standard Mode: raw prompt, minimal system prompt, flag `passthrough`.
8. **Knowledge retrieval (Tier 2, JSON text path only)** → `knowledge.service.ts` semantic search (Cohere embed `search_query` → pgvector cosine top-K by distance, `binding_level` only breaks distance ties, gated at `KNOWLEDGE_MIN_SCORE`); 2s self-timeout, failure degrades to `[]`. Emits SSE `embedding`. **Finalize:** a `tier3-candidate` with empty retrieval escalates to the external gateway (`auto-tier-3`, flag `sovereign-tier-3`); non-empty stays private.
9. **System prompt enrichment** → role (single `General Purpose Assistant`) + `FORMAT_INSTRUCTION` + retrieved `[Sumber: {title}, {section}]` reference block + grounding clause.
10. **Inference** → `inference.service.ts` `generate()` single-shot Bedrock `ConverseStreamCommand`. **Tier-1 internal tool loop** (default OFF; gated by `TIER1_TOOLS_ENABLED` AND `executedModelId === (TIER1_TOOLS_MODEL_ID || AUTO_MODEL_ID)`, never on sovereign-tier-3): runs an additive bounded `runToolLoop` — ≤`TIER1_MAX_TOOL_ITERATIONS` tool-capable rounds each offering `search_internal_knowledge(query, doc_type?)` (top `TIER1_TOOL_TOP_K` chunks **in full**, count-capped — search path NOT PII-masked), then one plain forced round with tools stripped; tokens sum into a single final `metadata` + `done`. Non-tool path is byte-identical to pre-feature. For multimodal requests a two-stage OCR pipeline runs first (§ Document Processing). Retries throttling errors (429) with exponential backoff; fails fast on timeouts/model errors.
11. **External Tier-3 path** (escalated only) → `tier3.service.ts` default model + `external-chat.service.ts` OpenAI-compatible SSE client; bounded ReAct loop (≤3) with `tool-registry.service.ts` local tools (`get_current_datetime`) offered only to `TIER3_TOOL_MODEL_PREFIXES`-allowlisted models; streams `reasoning`/`tool_call`; reasoning never persisted; one summed `metadata` + one audit row; B1 empty-content guard.
12. **Session Memory** → `session-memory.service.ts` three-tier: (T1) raw recent turns verbatim, (T2) rolling summary via qwen3-32b on eviction, (T3) structured facts (`extracted_facts` JSONB on sessions). Injected into prompts on subsequent turns.
13. **Assistant Message Storage** → On success, sanitized assistant text (re-masked with PII) is stored and `turn_count` increments. On storage failure, session transitions to `degraded` state and a `session_status` SSE event is emitted.
14. **Audit Log** → Metadata-only (no full prompt/response) fire-and-forget insert to `audit_logs`, with a pricing snapshot captured at inference time. Routing metadata + `knowledge_sources` (chunk ids) + `embedding_input_tokens` + Tier-1 `tool_calls_meta` (masked args at write time) included.

The multipart file-upload path (§ 3.4 in readme) runs OCR/image flow and does **not** run knowledge search.

### SSE Events Emitted During Inference

| Event | When | Content |
|---|---|---|
| `session` | Start of stream | `{ sessionId }` |
| `routing` | After routing decision (if enabled) | Trimmed `RoutingMetadataEvent` — routingState, executedModelId, routingReasonCode, modalityFlags, flags |
| `embedding` | After knowledge retrieval | `{ inputTokens, chunks: [{id, title, docType, score, bindingLevel, sourceType}] }` |
| `delta` | Per token from Bedrock | `{ type: "text", content: "<token>" }` |
| `reasoning` | Tier-3 external only (thinking-capable model) | `{ content }` per CoT token — never persisted/logged |
| `tool_call` | Tier-3 ReAct round OR Tier-1 tool round | `{ tools: [...] }` — once per tool round |
| `metadata` | End of stream | `{ inputTokens, outputTokens }` (Tier-3/Tier-1 loop: summed across iterations) |
| `session_status` | On storage failure | `{ sessionId, is_degraded: true }` |
| `done` | End of stream | `{}` |
| `error` | On failure | `{ error, message }` |

Batch endpoint (`POST /api/v1/inference/batch`) uses plain JSON, no SSE. No `orchestration_status`/`verification` events — sequential reasoning and deterministic verification were removed in Tahap 1.

### Routing Reason Codes (Tahap 1)

| reasonCode | Branch | Meaning |
|---|---|---|
| `auto-fixed-model` | auto | access granted → fixed `config.routing.autoModelId` (private Bedrock) |
| `auto-tier-1` | auto | restricted (PII or lexicon hit) → private `tier1ModelId \|\| autoModelId`; flag `sovereign-tier-1` |
| `auto-tier-3` | auto | `tier3-candidate` + empty knowledge retrieval → external OpenAI-compatible gateway; flag `sovereign-tier-3` |
| `auto-access-denied` | auto | user not whitelisted for the auto model → DEFAULT_MODEL (qwen3-32b), flag set, candidate dropped |
| `manual-override` | manual | user-picked model honored |
| `passthrough` | passthrough | Standard Mode / raw prompt, minimal system prompt |

**Allowed models** (`src/types/inference.types.ts` → `ALLOWED_MODELS`): `amazon.nova-lite-v1:0`, `anthropic.claude-sonnet-5`, `openai.gpt-oss-120b-1:0`, `qwen.qwen3-235b-a22b-2507-v1:0`, `qwen.qwen3-32b-v1:0`, `zai.glm-5`. Capabilities (vision, max output tokens) in `src/config/model-capabilities.ts`. `deepseek.v3.2` is reserved for long-output batch inference (meeting summaries). External Tier-3 models are **not** in `ALLOWED_MODELS` — admin-managed rows in `tier3_models` via `GET/PUT /api/v1/admin/tier3`.

**Important:** `DEFAULT_MODEL` = `qwen.qwen3-32b-v1:0` (access-denied fallback + session-memory summary/facts). Auto routing uses `config.routing.autoModelId` (default `qwen.qwen3-235b-a22b-2507-v1:0`). Auto mode issues ZERO LLM routing calls — classification/refinement/scoring/verification were removed in Tahap 1.

### Document Processing Pipeline

When images or documents are attached, the pipeline adapts based on file type:

**Images / unparseable documents (empty text extraction):**
1. **Stage 1:** Nova Lite (`amazon.nova-lite-v1:0`) performs OCR/extraction via raw `InvokeModel` API (Messages schema — Nova does not support Converse).
2. **Stage 2:** GPT-OSS 120B (`openai.gpt-oss-120b-1:0`) enhances the extracted text into a comprehensive response.
3. **Fallback:** If Nova OCR fails or returns empty, GPT-OSS 120B handles the images natively.

**Legacy Office formats (.doc, .ppt):**
- Routed through Gotenberg sidecar (`gotenberg.service.ts`) for LibreOffice-based conversion to PDF, then text extraction via pdf-parse.
- Configured via `GOTENBERG_URL` env var. Gracefully degrades if not configured (returns low-confidence empty result).

**File validation:**
- `file-signature-validator.ts` checks magic bytes against declared MIME type as a heuristic gate (not a security boundary — structural validation happens in each extractor).
- Extraction safety limits: max JSON nesting depth (20), max HTML tag depth (100), max CSV rows (100K), max PPTX ZIP entries (2000).
- Upload limits: max 5 files, 10MB/file, allowed types: PDF, DOCX, PNG, JPEG, WEBP. All in-memory processing.

### PII Masker Details

Detects five Indonesian entity types (`src/types/pii.types.ts`):
- **NIK**: 16-digit national ID validated against province codes
- **NO_HP**: Mobile numbers (08xx, +62, 62) validated against operator prefixes
- **NO_REKENING**: 8-15 digit sequences in banking context (keywords like "rekening", "transfer ke")
- **NAMA**: Person names via title prefixes (Bapak/Ibu/Pak/etc.) and capitalized word sequences, with an exclusion list for common words
- **NAMA_BANK**: Bank names from a curated Indonesian bank dictionary with fuzzy alias matching

Detections are resolved left-to-right (longest match wins), then assigned indexed placeholders (`[NIK_1]`, `[NIK_2]`, etc.). Masking is one-way — there is no unmasking step.

## Key Files

| File | Role |
|---|---|
| `src/server.ts` | Entry point — starts HTTP listener |
| `src/app.ts` | Express app setup — middleware stack, route mounting, error handler, health endpoint |
| `src/config/index.ts` | All configuration from env vars with defaults |
| `src/config/database.ts` | PostgreSQL connection pool (pg `Pool`, max 20) |
| `src/config/model-capabilities.ts` | Static registry of model capabilities and max output tokens |
| `src/config/skill-role-map.ts` | Static role map — collapsed to single `{fallback: 'General Purpose Assistant'}` (Tahap 1) |
| `src/routes/inference.routes.ts` | `POST /generate` SSE (routing, knowledge retrieval, Tier-1/Tier-3 dispatch), `POST /batch` M2M, session active/reset, multipart + OCR |
| `src/routes/session.routes.ts` | Session listing, message history, stats, resume |
| `src/routes/admin.routes.ts` | User CRUD, cost reports, `GET/PUT /config`, `GET/PUT /env`, `/restricted-terms` CRUD, `GET/PUT /tier3`, cost/report, feedback admin |
| `src/routes/admin-applications.routes.ts` | Multi-tenant applications + API keys CRUD (admin-only) |
| `src/routes/auth.routes.ts` | Login, Google OAuth, change-password |
| `src/routes/models.routes.ts` | Available models listing with pricing |
| `src/routes/feedback.routes.ts` | User feedback submission with background synthesis via qwen3-235b |
| `src/routes/generation.routes.ts` | `POST /pptx`, `POST /pdf` — HTML/CSS path via Gotenberg Chromium + JSON/python-pptx fallback |
| `src/routes/knowledge.routes.ts` | Tier 2 knowledge: async document upload (202), metadata/extract, list/status, admin classification mgmt |
| `src/services/inference.service.ts` | Bedrock `ConverseStream`/`Converse`/`InvokeModel`, retry logic, SSE mapping, Nova OCR, Tier-1 `runToolLoop` (`generate(req,res,toolLoop?)`) |
| `src/services/routing-engine.service.ts` | Sovereign-tier deterministic router: `classifySovereignTier` (PII + restricted lexicon) → auto-tier-1 / auto-fixed-model (+ tier3-candidate); manual/passthrough |
| `src/services/routing-policy.service.ts` | Manual-override policy resolution (used by manual branch only) |
| `src/services/tier3.service.ts` | External Tier-3 default model resolution from `tier3_models` |
| `src/services/external-chat.service.ts` | Tier-3 OpenAI-compatible SSE client — bounded ReAct loop, reasoning/tool_call SSE, summed tokens, B1 empty-content guard |
| `src/services/tool-registry.service.ts` | Safe local tools (`get_current_datetime`) offered only to allowlisted Tier-3 models |
| `src/services/tier1-tools.service.ts` | Tier-1 private-Bedrock tool registry (`search_internal_knowledge`) + executor — internal pgvector search, search path NOT PII-masked |
| `src/services/knowledge.service.ts` | Tier 2: chunk → hash-dedup → bulk-embed → index; semantic search (2s self-timeout) |
| `src/services/embedding.service.ts` | Cohere Embed v4 — `generateEmbedding()` + batched `generateEmbeddings()` (≤96/call) |
| `src/services/restricted-terms.service.ts` | Restricted-word lexicon CRUD (sovereignty classifier, live restrict) |
| `src/services/session-memory.service.ts` | Three-tier memory: raw turns, rolling summary (qwen3-32b), structured facts extraction |
| `src/services/api-key.service.ts` | Multi-tenant API key generate (SHA-256) + validate (`timingSafeEqual`) |
| `src/services/application.service.ts` | Multi-tenant application CRUD (admin-only) |
| `src/services/config.service.ts` | App config (`passthrough_mode`) with DB + in-memory cache |
| `src/services/gotenberg.service.ts` | HTML→PPTX/PDF (Chromium), Office→PDF (LibreOffice), legacy .doc/.ppt → text |
| `src/services/pptx-generator.service.ts` | PPTX/PDF slide/document HTML generation (10 themes, 7 layouts, content-adaptive) |
| `src/services/pii-masker.service.ts` | Regex/heuristic PII detection and one-way masking |
| `src/services/session.service.ts` | Session lifecycle — create, validate, expire, degrade, messages CRUD, stats aggregation |
| `src/services/context-assembly.service.ts` | `buildContext()` — sliding-window history selection with character budget; produces inference and routing payloads |
| `src/services/auth.service.ts` | Login, JWT sign/verify, password change, user CRUD, Google OAuth verification |
| `src/services/audit.service.ts` | Fire-and-forget audit log persistence with pricing snapshots |
| `src/services/cost-reporting.service.ts` | Per-user cost aggregation from audit_logs with per-model breakdown |
| `src/services/content-builder.service.ts` | Assembles ordered ContentBlocks for Bedrock Converse (text → documents → images) |
| `src/services/document-extractor.service.ts` | PDF/DOCX/PPTX/XLSX/HTML/JSON/CSV/TXT/MD/XML text extraction in-memory, with safety limits |
| `src/services/file-signature-validator.ts` | Magic byte validation against declared MIME type (heuristic gate) |
| `src/services/image-processor.service.ts` | Image buffer → Bedrock-compatible base64 content blocks |
| `src/services/upload-validator.service.ts` | Classifies multipart files into documents/images, validates MIME types |
| `src/middleware/auth.middleware.ts` | JWT Bearer token validation |
| `src/middleware/admin.middleware.ts` | Admin role guard (must follow auth middleware) |
| `src/middleware/password-reset.middleware.ts` | Enforces forced password reset (blocks all routes except change-password) |
| `src/middleware/security.middleware.ts` | Security headers, in-memory rate limiters (login 5/15min, API 100/min, inference 20/min) |
| `src/middleware/upload.middleware.ts` | Multer config (memory storage, 10MB/file, max 5 files, MIME type filtering), error handler |
| `src/frontend/cost-display.ts` | Client-side cost calculation with live USD→IDR conversion |
| `src/scripts/run-migrations.ts` | Idempotent migration runner (tracked via `_migrations` table) |

## Database

PostgreSQL with connection pool (max 20). Schema is in `migrations/` — apply in order with `npx tsx src/scripts/run-migrations.ts` (idempotent — creates `_migrations` tracking table). Seed the first admin user with `npx tsx scripts/seed-admin.ts` (creates admin/admin123).

Key migrations (34 total, applied sequentially):
- `001-006` — Core schema: users, sessions, messages, audit_logs, upload fields, routing metadata, conversation memory, session hardening, pricing snapshots
- `007-008` — Session memory: `rolling_summary`, `memory_version`, `extracted_facts` JSONB on sessions
- `009-018` — `group_name`, sub-agent orchestration, Google OAuth, orchestration audit, model access control, feedback reports, skill taxonomy, discovered roles, routing/session context
- `019-021` — Billing context, passthrough flag, app config table
- `022-023` — Multi-tenant: `applications` + `api_keys`, audit `api_key_id`/`application_id` FKs (nullable username)
- `024-030` — Knowledge layer (Tier 2): `knowledge_documents` (pgvector VECTOR(1536)), `knowledge_ingestion_jobs`, audit `knowledge_sources` + `embedding_input_tokens`, classification → columns + CHECK constraints (19 doc_type / 7 binding_level / 3 source_type / 3 sensitivity)
- `031` — Knowledge admin indexes (source_file)
- `032` — `tier3_models` external model registry (admin-managed, one default)
- `033` — `restricted_terms` sovereignty lexicon (admin-editable)
- `034` — `audit_logs.tool_calls_meta` JSONB (Tier-1 tool-loop audit, default `'[]'`)

## Deployment

Single deployment target: **GCP Cloud Run** (`cloudbuild.yaml`).

Builds the root `Dockerfile` (multi-stage Alpine build), pushes to Artifact Registry, deploys to Cloud Run in `asia-southeast2`. Uses Secret Manager for DB credentials (GCP Cloud SQL, public IP + SSL), Bedrock access keys (AWS Account #1), and JWT secret. Configured for 512Mi memory, 1 CPU, 300s timeout, max 10 instances, concurrency 80. `cloudbuild-pptx.yaml` deploys the python-pptx microservice (separate internal Cloud Run, scale-to-zero).

Architecture: `Cloud Run (app) → AWS Bedrock Account #1 (LLM, ap-southeast-3) + GCP Cloud SQL (PostgreSQL)`

Infrastructure docs: `infra/README.md` covers setup, secrets, and environment variables. One-time setup: `bash infra/gcp-setup.sh`.

## Testing

Tests use **Vitest** with `@/` path alias mapped to `src/`. Test files mirror the source structure under `tests/unit/`. Some tests use `fast-check` for property-based testing. Test coverage excludes `src/server.ts` (entry point).

Key test files include (37 files, 480 tests — full list in readme.md §13):
- `tests/unit/inference.routes.test.ts` — text-only and multipart inference flows
- `tests/unit/inference.service.test.ts` — Bedrock call logic, retries, Tier-1 tool-loop tests (`generate(req,res,toolLoop?)`)
- `tests/unit/inference-retry.test.ts` — throttling retry behavior
- `tests/unit/pii-masker-nama.test.ts` — PII name detection property-based tests (fast-check)
- `tests/unit/pii-detection.test.ts` — PII detection precision/recall
- `tests/unit/routing-engine.test.ts` — sovereign-tier classify + auto/manual/passthrough reason codes
- `tests/unit/tier1-tools.service.test.ts` — Tier-1 loop registry, top-K count-cap, doc_type filter, no-PII-mask, default-OFF anchor
- `tests/unit/knowledge.service.test.ts` / `embedding.service.test.ts` / `knowledge.routes.test.ts` — Tier 2 ingestion/search/API
- `tests/unit/external-chat.service.test.ts` / `external-chat-tools.test.ts` — Tier-3 SSE + ReAct loop
- `tests/unit/restricted-terms.service.test.ts` / `tier3.service.test.ts` — sovereignty lexicon + external registry
- `tests/unit/session-memory.test.ts` — three-tier memory and fact extraction
- `tests/unit/cost-reporting.service.test.ts` — cost aggregation logic
- `tests/unit/content-builder.test.ts` — content block assembly
- `tests/unit/context-assembly.service.test.ts` — sliding window and budget management
- `tests/unit/file-signature-validator.test.ts` — magic byte validation
- `tests/unit/auth-google.test.ts` — Google OAuth flow

## Important Patterns

- **Deterministic auto routing (Tahap 1)**: Auto mode = one fixed model (`config.routing.autoModelId`, qwen3-235b). ZERO LLM routing calls; skill always `fallback`; raw prompt passed through unchanged. `routingReasonCode` + `flags` are the sovereign-tier seam.
- **Sovereign-tier gates (Phase 2)**: `classifySovereignTier` (PII hit OR restricted-word substring) forces the request private (`auto-tier-1`, `sovereign-tier-1` — never external); empty knowledge retrieval on a `tier3-candidate` escalates open text to the external gateway (`auto-tier-3`); restricted requests never leave Bedrock. Still zero LLM routing calls.
- **Fail-closed PII masking**: If the PII masker throws, the inference is rejected (500) rather than sending unmasked data to Bedrock. Post-inference PII scan on the batch endpoint (defense-in-depth).
- **Single-shot dispatch**: Every request runs one `generate()` (Bedrock ConverseStream). Sequential reasoning, PromptContracts, deterministic/semantic verification, auto-repair, and the few-shot library were **removed** in Tahap 1 — do not reintroduce.
- **Graceful degradation**: Audit log failures silently caught (fire-and-forget). Assistant message storage failure → `degraded` session + `session_status` SSE. Gotenberg unavailability → low-confidence empty result (no throw). Knowledge retrieval self-timeouts to `[]` (inference never blocked). Tier-1/Tier-3 tool-execution failures fall through gracefully (never double `done`/`metadata`, never unhandled rejection).
- **Three-tier session memory**: (T1) Raw recent turns via sliding window, (T2) Rolling summary generated when context budget exceeded, (T3) Structured facts extracted after each turn. Summary injected into prompts; facts stored as `extracted_facts` JSONB.
- **Tier-1 tool loop = default OFF**: `TIER1_TOOLS_ENABLED` false by default — the 2-arg `generate(req,res)` path is byte-identical to pre-feature. Tool loop gated on enabled + `executedModelId === (TIER1_TOOLS_MODEL_ID || AUTO_MODEL_ID)`, never on sovereign-tier-3 escalation. Search path NOT PII-masked (masking corrupts the embed); PII masking applied only at audit write time. Tool args masked + capped 500 chars in `audit_logs.tool_calls_meta`; raw query/result never stored.
- **Tier-3 external reasoning/tools**: `reasoning` SSE content and intermediate tool frames are echoed in-memory only — **never persisted or logged**. Only final non-empty content stored (B1 guard). Tools (`get_current_datetime`) offered only to `TIER3_TOOL_MODEL_PREFIXES`-allowlisted models. Tier-3 gateway key is env-only, never returned/stored; Tier-3 tools never touch internal DB/PII/knowledge.
- **Turn lock**: An in-memory `Map` (not distributed) prevents concurrent turns on the same session. Released in a `finally` block.
- **No full content logging**: Audit logs record metadata only (model, tokens, duration, routing decision). Never store prompt or response content.
- **Sanitized errors**: AWS Bedrock errors are sanitized before reaching the client — no ARNs, request IDs, or stack traces exposed.
- **Knowledge retrieval (Tier 2)**: Every JSON text inference turn embeds the effective prompt (Cohere `search_query`) and retrieves top-K chunks into the system prompt with `[Sumber: {title}]` citations; cosine-distance sort primary, `binding_level` CASE only breaks distance ties (ranking binding first hid the most relevant non-regulatory chunk behind regulatory rows — see tier-3 fix); rows below `KNOWLEDGE_MIN_SCORE` dropped → empty result escalates a candidate to Tier-3 (no keyword fallback — weak semantic means "not covered", never grounds on generic word overlap). Audit traceability via `knowledge_sources` + `embedding_input_tokens`.
- **Knowledge ingestion batching**: content-hash dedup via `content_hash = ANY($1::text[])`, then batch embed (`KNOWLEDGE_EMBED_BATCH_SIZE`, default 32, ≤96) — large PDFs index in a handful of Cohere calls.
- **Pricing snapshots**: Model pricing is captured at inference time in `audit_logs.model_pricing_snapshot` for historical cost accuracy, independent of future pricing changes.
- **Passthrough mode (Standard Mode)**: Admin-toggleable global flag (`app_config.passthrough_mode`) forcing `routingState='passthrough'` — raw prompt, minimal system prompt, audit `passthrough=true`. Chat UI shows read-only banner.
- **Runtime config overrides**: `GET/PUT /api/v1/admin/env` mutates the live config singleton (`KNOWLEDGE_MIN_SCORE`, `ROUTING_METADATA_ENABLED`, `TIER3_ENABLED`) — used for backtesting without a redeploy.
- **Multi-tenant API keys**: SHA-256 hashed, `timingSafeEqual` comparison; batch endpoint resolves to a system user; `api_key_id`/`application_id` audit FKs replace the old `api_key_used` boolean.
- **File buffer cleanup**: After multipart inference, file buffers are explicitly nullified for garbage collection.
- **Prompt length limits**: JSON requests limited to 64K chars; multipart prompts checked against `maxContextCharacters` (default 640K); JSON body parser limit `10mb`.
- **User feedback loop**: `POST /api/v1/feedback` accepts user-reported errors (hallucination, missed_context, wrong_tone, formatting_issue, other) and triggers background synthesis via qwen3-235b, enriched from `audit_logs`.
- **Batch endpoint**: Non-streaming, manual-routing-only, post-inference PII scan, billing context (`billed_user_id`/`billed_group`), plain JSON response.
