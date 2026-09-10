# Tech Reference: Siap Ditanya — Unified Inference Gateway

> SIstem AI Privasi, DIpetakan perTANYAannya. For code review & evaluation. Covers architecture, tech stack, routing, memory, and all subsystems.

---

## 1. Tech Stack

| Layer | Technology | Version / Notes |
|---|---|---|
| Runtime | Node.js | 24 (Alpine in Docker) |
| Language | TypeScript | 5.6+, `NodeNext` module resolution |
| Framework | Express.js | 4.21+ |
| Database | PostgreSQL (GCP Cloud SQL) | pg Pool (max 20), SSL via `rejectUnauthorized: false` |
| Vector search | pgvector | Cosine similarity (`<=>`) on VECTOR(1536), relevance gate |
| Embeddings | Cohere Embed v4 (Bedrock inference profile) | `global.cohere.embed-v4:0`, 1536-d, cross-region from ap-southeast-3 |
| AI Models | AWS Bedrock | ap-southeast-3 (Jakarta) only |
| Bedrock SDK | `@aws-sdk/client-bedrock-runtime` | ^3.700 |
| Document parsing | `pdf-parse`, `mammoth`, `officeparser`, `cheerio`, `xlsx`, `turndown` + GFM | PDF, DOCX, PPTX, XLSX, HTML, Markdown output |
| Office conversion | Gotenberg (sidecar Cloud Run service) | .doc, .ppt → PDF → text |
| Auth | JWT (`jsonwebtoken`) + bcrypt + Google OAuth (`google-auth-library`) + Multi-Tenant API Key (SHA-256, timingSafeEqual) | HS256, local + Google sign-in + per-application M2M keys |
| File uploads | `multer` | Memory storage, 10MB/file, max 5 files |
| PPTX generation | HTML-first via Gotenberg Chromium + JSON fallback via `python-pptx` | 10 CSS Variable-based themes, 7 layouts, content-adaptive layout selection, 5 rhythm patterns |
| PDF generation | Gotenberg (HTML→PDF Chromium, document-centric HTML) | A4 format, CSS @page, serif typography, separate document prompt |
| Testing | Vitest | `@/` alias → `./src/*` |
| Linting | ESLint 9 + `typescript-eslint` | Flat config |
| Build | `tsc` | Output: `dist/` |
| Dev server | `tsx watch` | Hot reload |
| Property testing | `fast-check` | For PII masker |
| JSON body limit | 10MB | Previously 10KB, raised for long prompts |
| Routing | Sovereign-tier (Phase 2) | Auto = restricted (PII/lexicon) → private Bedrock (`auto-tier-1`); open text → private default; gateway-on + empty knowledge retrieval → external Tier-3 (`auto-tier-3`). Zero LLM routing calls; manual + passthrough preserved |
| Default model | Auto → Qwen3 235B A22B | Frontend model dropdown defaults to "Auto"; auto route → `qwen.qwen3-235b-a22b-2507-v1:0` (env `AUTO_MODEL_ID`); access-denied fallback → qwen3-32b |

### Deployment targets

| Target | Config | Notes |
|---|---|---|
| GCP Cloud Run | `Dockerfile` + `cloudbuild.yaml` | Artifact Registry + Secret Manager, `asia-southeast2` |
| Local dev | `npm run dev` | `.env` at root, `npx tsx` |

### Network topology

```
Users → GCP Cloud Run (asia-southeast2)
           ├── AWS Bedrock Account #1 (LLM inference, ap-southeast-3)
           ├── GCP Cloud SQL (PostgreSQL, public IP + SSL)
           └── python-pptx service (Cloud Run internal, asia-southeast2)
External Apps (M2M) → POST /api/v1/inference/batch (x-api-key header, SHA-256 hashed, per-application billing)
```

---

## 2. Code Layout

```
src/
├── server.ts              # HTTP listener entry + EventEmitter.defaultMaxListeners = 50
├── app.ts                 # Express app: middleware, routes, error handler, /health, /config/passthrough, Cache-Control on HTML
├── config/
│   ├── index.ts           # All env-var config with defaults
│   ├── database.ts        # pg Pool + query() helper + closePool()
│   └── model-capabilities.ts  # Static model→capability registry (6 models)
├── middleware/
│   ├── auth.middleware.ts       # JWT Bearer + Multi-Tenant API Key (SHA-256 DB lookup, conditional x-username enforcement)
│   ├── admin.middleware.ts      # Admin role guard (blocks api_key role)
│   ├── password-reset.middleware.ts  # Force password reset gate
│   ├── security.middleware.ts       # Security headers, rate limiters (login/API/inference)
│   └── upload.middleware.ts         # Multer config, MIME whitelist, error handler
├── routes/
│   ├── auth.routes.ts        # POST /login, POST /google, GET /google/config, POST /change-password
│   ├── admin.routes.ts       # POST|PUT /users, GET /usage/cost (extended: applicationId, apiKeyId, username filters), POST /users/bulk
│   │                         # + GET/PUT /config (passthrough_mode), GET/PUT /env (runtime overrides), CRUD /restricted-terms,
│   │                         #   GET/PUT /tier3 (external model registry), GET /cost/report, GET /feedback…
│   ├── admin-applications.routes.ts  # CRUD /applications, CRUD /applications/:id/keys, PUT /keys/:id, DELETE /keys/:id
│   ├── models.routes.ts      # GET / (available models with pricing)
│   ├── inference.routes.ts   # POST /generate (SSE streaming + grounding), POST /batch (multi-tenant API key auth, x-username header)
│   │                         # + GET /sessions/active, POST /sessions/reset
│   ├── generation.routes.ts  # POST /pptx, POST /pdf (document HTML for PDF, slide HTML for PPTX, multipart, context injection)
│   ├── session.routes.ts     # GET /, GET /:id/messages, GET /:id/stats, POST /:id/resume
│   ├── feedback.routes.ts    # POST / (submit), GET/PUT /admin (admin review + synthesis)
│   └── knowledge.routes.ts   # Knowledge (Tier 2): POST /documents (async 202), POST /metadata/extract, GET /documents,
│                            #   GET /documents/:id/status, GET /documents/ingested + PATCH/DELETE /documents/:sourceFile (admin classification mgmt)
├── services/
│   ├── auth.service.ts           # Login, JWT sign/verify, user CRUD, Google OAuth
│   ├── session.service.ts        # Session lifecycle, messages CRUD, stats
│   ├── inference.service.ts      # Bedrock ConverseStream/Converse/InvokeModel, retry, SSE, OCR
│   ├── routing-engine.service.ts # Sovereign-tier: classifySovereignTier() (PII + restricted lexicon) →
│   │                            #  restricted 'auto-tier-1' (tier1ModelId||autoModelId); open → 'auto-fixed-model'
│   │                            #  (+ 'tier3-candidate' when T3 gateway on + text-only + default exists)
│   ├── routing-policy.service.ts # resolvePolicy — manual override resolution (used by manual branch only)
│   ├── tier3.service.ts          # getDefaultTier3Model — external Tier-3 default from tier3_models
│   ├── external-chat.service.ts  # Tier-3 OpenAI-compatible SSE client — bounded ReAct tool loop, reasoning/tool_call SSE, summed tokens, B1 empty-content guard
│   ├── tool-registry.service.ts  # Safe local tools (get_current_datetime) — offered only to config-allowlisted Tier-3 models
│   ├── tier1-tools.service.ts    # Tier-1 private-Bedrock tool registry (search_internal_knowledge) + executor — internal
│   │                            #  pgvector search; search path NOT PII-masked (fully internal, masking corrupts the embed)
│   ├── pii-masker.service.ts     # Indonesian PII detection (NIK, HP, rekening, nama, bank)
│   ├── context-assembly.service.ts    # Sliding window, char budget, routing_payload, summary+facts injection
│   ├── session-memory.service.ts      # Load memory state, summarize evicted, extract facts
│   ├── content-builder.service.ts      # Ordered content blocks for Bedrock Converse
│   ├── document-extractor.service.ts   # PDF, DOCX, PPTX, XLSX, HTML, JSON, CSV, TXT, MD, XML (output: Markdown)
│   ├── image-processor.service.ts      # Image buffer → base64 content block
│   ├── upload-validator.service.ts     # Classify files → documents/images, MIME checks
│   ├── embedding.service.ts            # Cohere Embed v4 — generateEmbedding() + generateEmbeddings() (batch ≤96/call)
│   ├── knowledge.service.ts            # Tier 2: chunk → hash-dedup → bulk-embed → index; semantic search (2s self-timeout)
│   ├── restricted-terms.service.ts     # Restricted-word lexicon CRUD (sovereignty classifier, live restrict)
│   ├── audit.service.ts                # Fire-and-forget audit logs + api_key_id + application_id FKs + tool_calls_meta
│   ├── cost-reporting.service.ts       # Per-user cost aggregation + application/api-key filters
│   ├── config.service.ts               # App config (passthrough_mode) with DB + in-memory cache
│   ├── application.service.ts          # Multi-tenant application CRUD (admin-only)
│   ├── api-key.service.ts              # API key generate (bex_ + 32 hex, SHA-256), validate, CRUD, timingSafeEqual
│   ├── gotenberg.service.ts            # HTML→PPTX (cheerio→JSZip), HTML→PDF (Chromium, slide + document formats), Office→PDF
│   ├── pptx-generator.service.ts        # PPTX: HTML slide generation (10 themes, 7 layouts, content-adaptive). PDF: document HTML generation (A4, serif).
│   ├── pptx-themes.ts                  # 10 CSS Variable-based themes + 7 layout classes
│   └── file-signature-validator.ts     # Magic byte heuristic gate
├── frontend/
│   ├── cost-display.ts          # IDR rate fetch, session cost tracking
│   └── pricing-config.json      # Per-model pricing (input/output per 1M tokens, + DeepSeek V3.2)
├── types/
│   ├── auth.types.ts            # TokenPayload (role: admin|user|api_key), LoginResult, UserProfile
│   ├── api-key.types.ts         # Application, ApiKey, ApiKeyCreated, ApiKeyContext
│   ├── session.types.ts         # Session, StoredMessage, BedrockMessage, AssembledContext, SessionStats
│   ├── inference.types.ts       # RoutingMetadataEvent (trimmed), ModalityFlags
│   ├── routing.types.ts         # SkillType='fallback'; RoutingInput (piiDetected)/RoutingDecision (no contract); reasonCode/flags = sovereign seam
│   ├── knowledge.types.ts       # KnowledgeChunk, index/job params, DOC_TYPE/BINDING_LEVEL/SENSITIVITY maps
│   ├── pii.types.ts
│   ├── upload.types.ts          # DocumentFile, ImageFile, ExtractionResult, ContentBuildInput, ContentBlock
│   ├── audit.types.ts           # + apiKeyId, applicationId (deprecates apiKeyUsed); ToolCallAuditMeta + toolCallsMeta
│   ├── pptx.types.ts           # Content JSON schema for JSON fallback path (6 slide types), HTML path uses CSS layouts
│   ├── pricing.types.ts
│   ├── reporting.types.ts       # + applicationId, applicationName, apiKeyId, keyPrefix on UserCostReport
│   └── error.types.ts
└── scripts/
    ├── run-migrations.ts    # Idempotent migration runner (creates _migrations table)
    └── ingest-knowledge.ts  # CLI batch ingest — folder → extract → chunk → embed → index

data/                            # Runtime data (not committed to git)

pptx-service/                     # Python PPTX microservice (separate Cloud Run deployment)
├── main.py                       # FastAPI app: /health, /generate
├── generator.py                  # Code-based design engine: 6 slide types (JSON fallback path)
├── schemas.py                    # Pydantic validation (mirrors TypeScript types)
├── requirements.txt              # fastapi, uvicorn, python-pptx
└── Dockerfile                    # Python 3.12-slim

cloudbuild-pptx.yaml              # Separate Cloud Build trigger for python-pptx service

migrations/
├── 001_initial_schema.sql ... 021_app_config.sql
├── 022_applications_api_keys.sql   # Multi-tenant: applications + api_keys tables
├── 023_alter_audit_logs.sql        # Multi-tenant: api_key_id, application_id FKs, nullable username
├── 024…030_knowledge_layer.sql     # Knowledge (Tier 2): knowledge_documents (pgvector VECTOR(1536)),
│                                   #   knowledge_ingestion_jobs, audit knowledge_sources + embedding_input_tokens,
│                                   #   classification → columns + CHECK (19 doc_type / 7 binding_level / 3 source_type / 3 sensitivity)
├── 031_knowledge_admin_indexes.sql # Knowledge admin: source_file index (lookup/grouping)
├── 032_tier3_models.sql            # Tier-3 external model registry (admin-managed, one default)
├── 033_restricted_terms.sql        # Restricted-word lexicon (sovereignty classifier, admin-editable)
├── 034_tier1_tool_calls_meta.sql   # audit_logs.tool_calls_meta JSONB (Tier-1 tool-loop audit, default '[]')
├── 035_user_google_drive_tokens.sql # Google Drive OAuth refresh tokens (per user)
└── 036_session_internal_document.sql # sessions.internal_document_context/_title — sticky WGS doc (masked, ≤50k)

tests/
└── unit/                           # 40 test files, 542 tests
    ├── api-key.service.test.ts     # 13 tests (generate, hash, validate, deactivate, delete)
    ├── application.service.test.ts # 12 tests (CRUD, duplicate rejection, key_count)
    ├── api-key-auth.middleware.test.ts  # 8 tests (6 auth scenarios + error paths)
    ├── admin-applications.routes.test.ts # 10 tests (CRUD endpoints)
    ├── routing-engine.test.ts      # 17 tests (sovereign classify + auto/manual/passthrough)
    ├── tier1-tools.service.test.ts # 8 tests (registry, top-K cap, doc_type filter, no-PII-mask, config default-OFF)
    └── ... (31 other test files)

docs/
├── readme.md                    # This file
├── reference/                   # Current system reference docs
│   ├── prompt-reference.md      # System prompt catalog
│   └── admin-dashboard.md       # Admin UI PRD
├── analysis/                    # Gap analysis & feature evaluation
│   ├── gap-analysis-blueprint-vs-implementation.md
│   └── evaluation-mcp-knowledge-layer.md
├── features/                    # Feature docs — requirements/design/tasks per feature
│   ├── google-auth/             # Google OAuth feature
│   ├── mcp-knowledge-layer/     # MCP knowledge layer (Tier 2) — implemented (phases 1-4 complete)
│   ├── model-access/            # Model access control design
│   ├── multi-tenant-api-key/    # Multi-tenant API key feature
│   ├── passthrough-mode/        # Passthrough mode feature
│   ├── auto-deterministic/      # Tahap 1: auto = fixed model, zero LLM routing — implemented
│   ├── pptx-generation/         # PPTX/PDF generation feature
│   ├── sequential-reasoning/    # Superseded — removed in Tahap 1 (historical)
│   ├── sovereign-tier-router/   # Phase 2: restricted→private T1 / knowledge-empty→external T3 — implemented
│   ├── tier3-tools/             # Tier-3 tools & thinking (bounded ReAct, reasoning SSE, config allowlist) — implemented
│   ├── tier1-tools/             # Tier-1 internal tool loop (search_internal_knowledge, multi-hop RAG) — implemented (default OFF)
│   ├── sub-agent/               # Sub-agent orchestration design
│   └── thinking-mode/           # Thinking mode requirements (historical)
├── design-notes/                # Historical design explorations & proposals
│   ├── improvement.md, improvement-CoT.md, llm2-enhance.md
│   ├── model-private-public.md, new-agents.md, new-agents-v4.md
│   ├── routing-enhance.md, user-feeback.md
│   └── beautify-render.md, ppt-doc-generation.md, ppt-pdf-beautify.md
│       prompt-improve.md, req-model-route.md, session-mem.md
└── assets/                      # Dev preview / test HTML
    ├── test-generation.html
    └── theme-preview.html

public/
├── admin.html                      # Admin dashboard — 7 tabs: Applications & Keys, Bulk Upload, Usage & Cost, Config (incl. runtime Env Overrides), Model Access, Feedback, Knowledge
└── index.html                      # SPA frontend — SSE streaming with progressive render (rAF-throttled), grounding instruction, model select (Auto default), chat TOC navigation, Tier-3 💭 reasoning + tool badge (a11y-safe)
```

---

## 3. Request Lifecycle

### 3.1 Interactive inference (JSON / multipart, SSE stream)

```
Client → POST /api/v1/inference/generate
  Body: { prompt, modelId?, config? }
  modelId: '' (default Auto) or a specific model ID (manual mode)
  
  1. authMiddleware           — JWT validation, attach req.user
  2. forcePasswordResetMiddleware — check flag
  3. inferenceRateLimit       — 20 req/min per IP
  4. Validate prompt          — non-empty, < 64K chars
  5. Validate modelId         — ALLOWED_MODELS (6 models) or empty (→ auto)
  6. PII mask prompt          — fail-closed: 500 if throws
  7. Prompt length check      — < maxContextCharacters
  8. Session validation       — getValidatedSession() (create or resume)
  9. Turn lock                — prevent concurrent turns on same session
  10. Store user message      — fail-fast: 500 if DB fails
  11. Load session messages
  12. Load memory state       — rolling_summary + extracted_facts
  13. buildContext()          — sliding window, char budget, inject summary+facts
      → inference_payload    — BedrockMessage[]
      → routing_payload      — last 2 user msgs + last assistant, ≤ 500 chars
      → evictedMessages[]    — for summary refresh
  14. Routing engine (Tahap 1 — deterministic, zero LLM routing calls):
      a. Determine routingState: 'auto' | 'manual' | 'passthrough'
      b. 'auto' → selectAutoModel(): model = config.routing.autoModelId (qwen3-235b)
         - if checkModelAccess() denies user access → DEFAULT_MODEL (qwen3-32b) + flag 'auto-access-denied'
         - reasonCode 'auto-fixed-model'; refinedPrompt = raw prompt (no refinement); skill 'fallback'
      c. 'manual' → resolvePolicy honors user-selected manualModelId (reasonCode 'manual-override')
      d. 'passthrough' → raw prompt, minimal system prompt, flag 'passthrough' (forced by Standard Mode)
  15. Emit SSE events:
      event: session      { sessionId }
      event: routing      { routingState, executedModelId, routingReasonCode, modalityFlags, flags, timing }
  15a. Knowledge retrieval (Tier 2)  → semantic search, 2s self-timeout, degrade to [] on failure
       - embed effectivePrompt (Cohere search_query) → cosine top-K (pgvector), sorted by distance first, binding_level only as tiebreak
       - rows below KNOWLEDGE_MIN_SCORE (default 0.4) dropped — no keyword fallback, so irrelevant
         queries return [] (graceful → sovereign routing escalates to Tier-3 instead of grounding noise)
       - emit event: embedding { inputTokens, chunks:[{id,title,docType,score,bindingLevel,sourceType}] }
       - empty retrieval on a `tier3-candidate` → escalate to external gateway (§4.1 finalize)
  15b. System prompt enrichment      → role + FORMAT_INSTRUCTION + retrieved reference block + citation rule
       "[Sumber: {title}, {section}]" + grounding line
  16. generate() single-shot         — Bedrock ConverseStream, SSE delta/metadata/done
       (sequential reasoning removed in Tahap 1; multipart two-stage OCR runs first — see §3.4)
  17. Store assistant msg    — PII-masked, increment turnCount
  18. Extract facts          — extractFacts() → update extracted_facts JSONB
  19. Audit log              — metadata-only, fire-and-forget
  20. Memory update          — if messages evicted, summarizeEvicted() → rolling_summary
  21. Release turn lock
```

**Knowledge scope note:** retrieval steps 15a–15b run on the JSON text-only path. The multipart file-upload path (§3.4) does not invoke knowledge search yet.

### 3.2 Batch inference (M2M, no session, no streaming)

```
Client → POST /api/v1/inference/batch
  Auth: X-API-Key header (apiKeyAuthMiddleware)
  Body: { prompt, modelId, config?, billingContext?, responseFormat? }
  
  1. apiKeyAuthMiddleware    — constant-time X-API-Key comparison
  2. Validate prompt          — non-empty, ≤256KB
  3. Validate modelId         — must be explicit (manual routing always)
  4. PII mask prompt          — fail-closed: 500 if throws
  5. Build system prompt      — JSON output schema for meeting_summary
  6. Call Bedrock ConverseCommand (non-streaming, single turn)
      - Retry without response_format if model rejects json_object
      - 120s timeout per call
  7. Post-inference PII scan  — defense-in-depth, discard output if PII leaks
  8. Parse structured output  — JSON → fallback markdown extraction
  9. Audit log                — with billing context (billedUserId, billedGroup, apiKeyUsed)
  10. Return JSON             — { summary, decisions, actionItems, metadata }
```

### 3.3 Passthrough mode (Standard Mode toggle)

When admin enables "Standard Mode" via the admin dashboard, ALL requests are forced to `routingState = 'passthrough'` (bypass the auto model router).
Triggered by global config flag `app_config.passthrough_mode = true`.

```
Client → POST /api/v1/inference/generate
  Same as JSON flow, except:

  4b. Check global passthrough — configService.getPassthroughMode() (cached in-memory)
  4c. If enabled → force routingState = 'passthrough'
  9b. routeRequest() returns minimal decision (skill=fallback, raw prompt, flag 'passthrough')

  11b. System prompt: "You are a helpful assistant. Respond in {lang}."
       + FORMAT_INSTRUCTION (7 explicit markdown rules)

  12b. Audit with passthrough=true flag
  13b. Chat UI shows "⚡ Standard Mode" banner (read-only)
```

### 3.4 Multipart inference (with file uploads)

```
Same as JSON flow, with additions:
  5b. UploadMiddleware      — multer, memory storage, MIME filter
  5c. Validate & classify   — split into documents/images
  5d. Check model vision    — if images, must be vision-capable model
  5e. Extract document text — format-aware extractor
  5f. PII mask extracted text
  5g. Build content blocks  — text → document labels → document blocks → images
  5h. Routing               — includes maskedDocumentText, hasImages
  5i. Two-stage OCR (if needsOCR):
      Stage 1: Nova Lite via InvokeModel (raw API, messages-v1 schema)
      Stage 2: GPT-OSS 120B enhances OCR output
  5j. effectiveDocText      — ocrText (if available) overrides extraction text
  5k. generate() single-shot (sequential reasoning removed in Tahap 1)
  5l. Fallback: If enhance model fails → auto-fallback to original routing model
```

### 3.5 PPTX/PDF Generation (File Download)

Two modes: **HTML path** (default, 10 CSS Variable-based themes + 7 layout classes) and **JSON path** (fallback, editable via python-pptx). Auto-detects Gotenberg availability.

#### HTML Path (default, `?format=html`)

```
Client → POST /api/v1/generate/pptx (or /pdf)
  Auth: JWT Bearer
  Body (JSON): { prompt, modelId?, context? }
  Body (Multipart): prompt + files + context

  1. Validate prompt — non-empty, < 16K chars
  2. Extract document text + conversation context → combined prompt
  3. Bedrock Converse (non-streaming, qwen3-235b):
     - System: Presentation Art Director persona + theme selection rules + layout matrix + few-shot examples
     - 10 CSS Variable-based themes (executive, neon, minimal, pop, ledger, teal, earth, pitch, statute, academic)
     - 7 layout classes (hero, split, bento-3, bento-4, timeline, quote, content)
     - LLM outputs only <section class="slide theme-X layout-Y"> elements — no <html>/<head>/<body>
     - maxTokens: 8192, temperature: 0.4 (retry: 0.2)
  4. Validation (via cheerio):
     - Theme consistency: all slides must use exactly one theme
     - Layout diversity: no consecutive same layout, max 1 layout-content per deck
     - Structure: min 4 slides, first=hero (cover), last=hero (closing)
  5. wrapHtml(): Node.js injects <html><head> with full 10-theme CSS + viewport (1280×720)
  6. Retry up to 3 attempts with specific validation error feedback
  7. PPTX: Gotenberg Chromium screenshots each slide (PNG, 1280×720, 5 concurrent)
     → JSZip compose .pptx (full-slide images, zero npm deps)
  8. PDF: Gotenberg Chromium /forms/chromium/convert/html → .pdf (native CSS, perfect fidelity)
  9. Return file download
```

**Theme auto-selection:** LLM analyzes document context and picks one theme:
- `theme-executive` — Annual reports, Board decks, C-Level
- `theme-neon` — Tech products, cybersecurity, SaaS
- `theme-minimal` — Keynote, product design, strategy
- `theme-pop` — Marketing, creative, events
- `theme-ledger` — Finance, banking, audit
- `theme-teal` — Healthcare, medical, science
- `theme-earth` — ESG, sustainability, CSR
- `theme-pitch` — Startup pitch, innovation
- `theme-statute` — Legal, compliance, government
- `theme-academic` — Training, education, onboarding

**Local dev preview:** When `GOTENBERG_URL` is not configured, the endpoint returns wrapped HTML directly (instead of PPTX). Open the `.html` file in a browser to preview themed slides. Use `?format=json` to use the JSON fallback path.

#### JSON Path (fallback, `?format=json`)

```
Same as HTML path, except:
  4. Bedrock Converse: JSON schema (6 slide types) instead of HTML
  6. Validate Content JSON — field-level checks, auto-fix null types
  8. PPTX: POST python-pptx service /generate → .pptx Buffer
  10. PDF: PPTX → Gotenberg /forms/libreoffice/convert → .pdf (lossy)
```

#### Auto-fallback Logic

```
If GOTENBERG_URL is configured → HTML path (10 themed CSS slides)
If GOTENBERG_URL is NOT configured → HTML preview (returns .html file)
Force JSON: ?format=json query param
Force HTML: ?format=html query param (fails if no Gotenberg)
```

### 3.6 Frontend Generation Commands

```
Chat input prefixes:
  /pptx <prompt>     → Generate .pptx presentation
  /pdf <prompt>      → Generate .pdf presentation

When triggered:
  1. getConversationContext() — collect last 4 user-assistant turns from DOM
  2. If files attached: send as multipart with context
  3. If no files: send as JSON with context
  4. Loading state: "⏳ Generating presentation..."
  5. Auto-download + clickable download link in chat
  6. Chat shows: "✅ Presentation ready! 0.X MB — 📥 Click here to download"

Context handling:
  - Previous turns injected as "--- KONTEKS PERCAKAPAN SEBELUMNYA ---"
  - /pptx and /pdf commands are excluded from context collection
  - Max 4 turns collected, capped at 6000 chars on backend

File input methods:
  - Drag & drop files onto chat input area
  - Click 📎 button → file picker
  - Clipboard paste (Cmd+V) — copy file from Finder/Explorer, paste into chat
```

---

## 4. Routing Engine

### 4.1 Architecture — Full `routeRequest(input)` Walkthrough

#### Input (`RoutingInput`)

```typescript
interface RoutingInput {
  originalPrompt: string;           // PII-masked user prompt
  piiDetected?: boolean;            // maskResult.entityCount > 0 — sovereignty gate signal
  maskedDocumentText?: string;      // PII-masked extracted document text
  hasImages: boolean;
  imageModelRequired: boolean;
  routingState: 'auto' | 'manual' | 'passthrough';
  manualModelId?: string;           // Set when user manually selects a model
  userId: string;
  conversationContext?: string;     // Reserved (unused in Tahap 1) — last 2 user msgs + last assistant
}
```

#### Output (`RoutingDecision`)

```typescript
interface RoutingDecision {
  executedModelId: string;          // model that will actually run
  routingState: 'auto' | 'manual' | 'passthrough';
  complexityScore: number;          // auto: 0; manual/passthrough: defaultFallbackScore — kept for shape-compat
  scoreBand: 'direct-answer' | 'moderate-reasoning' | 'advanced-reasoning';
  confidence: number;               // 1.0 (no scoring LLM)
  refinedPrompt: string;            // always the raw PII-masked prompt (no refinement)
  routingReasonCode: string;        // 'auto-fixed-model' | 'auto-access-denied' | 'manual-override' | 'passthrough'
  reasoningSummary: string;
  modalityFlags: ModalityFlags;     // textOnly | documentText | image | mixed
  manualOverrideApplied: boolean;
  passthrough?: boolean;
  flags: string[];                  // e.g. ['auto-access-denied'] / ['passthrough'] — extensible Phase-2 seam
  skill: SkillType;                 // always 'fallback' in Tahap 1
  sessionContext?: string;          // first 120 chars of prompt as session preview
  routingDurationMs?: number;
}
```

#### Step-by-step process (deterministic)

```
routeRequest(input)
│
├── routingState === 'manual'
│     └── resolvePolicy({ manual: true, manualModelId }) → modelId (honors user selection)
│         reasonCode 'manual-override'; manualOverrideApplied: true
│
├── routingState === 'passthrough'
│     └── model = manualModelId || qwen3-32b; raw prompt; flag ['passthrough']
│
└── routingState === 'auto'            ← default (frontend "Auto")
      └── classifySovereignTier({ prompt, piiDetected, documentText })   // Phase 2 — deterministic
            ├── restricted (PII hit OR restricted-word substring)
            │     → selectAutoModel: model = config.routing.tier1ModelId || autoModelId
            │         reasonCode 'auto-tier-1', flag ['sovereign-tier-1']   (private, never external)
            └── open text
                  └── selectAutoModel({ userId, hasImages, prompt })
                        ├── checkModelAccess(userId, model) denied
                        │     → DEFAULT_MODEL (qwen3-32b), 'auto-access-denied', no candidate
                        ├── gateway on + text-only + default Tier-3 model exists
                        │     → model = autoModelId, 'auto-fixed-model', flag ['tier3-candidate']
                        │         (provisional — knowledge search decides the final tier)
                        └── else → model = autoModelId, 'auto-fixed-model', flags []
            → refinedPrompt = raw prompt (no refinement), skill = 'fallback', no contract
```

**Knowledge-search finalize (JSON text path only):** the routing decision is provisional while the
request carries `tier3-candidate`. After Cohere retrieval runs, the handler finalizes it — if
retrieval returned **no** chunks the request escalates to the external gateway
(`auto-tier-3`, flag `sovereign-tier-3`, model = the enabled default Tier-3 model from
`tier3_models`), because there is no internal knowledge to keep private; if internal chunks were
found it **stays private** (candidate flag dropped, `auto-fixed-model`). The routing SSE event for a
candidate is deferred until this finalize step, so non-candidate requests are byte-identical to
Tahap 1. Restricted requests never carry the candidate flag and never leave Bedrock.

**External escalation gets a general-assistant system prompt, never the internal doc-grounding clause**
(`buildGroundingClause` in `inference.routes.ts`): escalation fires only when retrieval is **empty**, so
no internal document reaches the external gateway. Leaking the internal "answer only from provided
material / say `tidak tersedia dalam dokumen yang diberikan`" text into the external system message made
the Tier-3 model refuse live/open questions (observed: "berapa kurs dollar saat ini" escalated to
`auto-tier-3` yet answered "tidak tersedia dalam dokumen yang diberikan" — there was no document). The
clause is now selected per execution path — Tier-1 tool / sovereign-tier-3 external / internal — and the
external branch tells the model to answer from general knowledge, staying honest about real-time data it
cannot reach (pointing at authoritative sources instead of inventing a number). Internal and Tier-1-tool
turns keep their grounding clauses verbatim.

**What Tahap 1 removed** (old LLM router): 24-skill classifier, `validateSkillInvariants` (10 rules), per-skill prompt refinement + `PromptContract`, complexity scoring, few-shot library, sequential reasoning, deterministic + semantic verification & auto-repair, and the Discovered Roles write-hook/admin tab. `routingReasonCode` + `flags` are the sovereign-tier seam — see [`docs/features/sovereign-tier-router/`](docs/features/sovereign-tier-router/) for the Phase 2 design.

### 4.2 Decision reason codes

| reasonCode | Branch | Meaning |
|---|---|---|
| `auto-fixed-model` | auto | access granted → fixed `config.routing.autoModelId` (private Bedrock) |
| ↳ flag `sovereign-internal-document` | auto | the request carries a Google Workspace document (this turn's fetch **or** the session's sticky internal document) → `tier3-candidate` is never set — the conversation stays on private Bedrock |
| `auto-tier-1` | auto | restricted (PII or lexicon hit) → private `tier1ModelId \|\| autoModelId`; flag `sovereign-tier-1` |
| `auto-tier-3` | auto | `tier3-candidate` + empty knowledge retrieval → external OpenAI-compatible gateway; flag `sovereign-tier-3` |
| `auto-access-denied` | auto | user not whitelisted for the auto model → DEFAULT_MODEL (qwen3-32b), flag set, candidate dropped |
| `manual-override` | manual | user-picked model honored |
| `passthrough` | passthrough | Standard Mode / raw prompt, minimal system prompt |

### 4.3 Allowed Models

| Model ID | Vision | Max Output Tokens | Role (Tahap 1) |
|---|---|---|---|
| `amazon.nova-lite-v1:0` | Yes | 5,120 | OCR Stage 1 via InvokeModel |
| `openai.gpt-oss-120b-1:0` | Yes | 16,384 | OCR Stage 2 enhance (multipart images/docs) |
| `qwen.qwen3-235b-a22b-2507-v1:0` | Yes | 8,192 | Auto default + primary single-shot inference |
| `qwen.qwen3-32b-v1:0` | Yes | 8,192 | Access-denied fallback; session-memory summary/facts (Tier 2/3) |
| `anthropic.claude-sonnet-5` | Text-only | 8,192 | Alternate manual pick |
| `zai.glm-5` | Text-only | 8,192 | Alternate manual pick |
| `deepseek.v3.2` | Text-only | 81,920 | Long-output batch inference (meeting summaries) |

`deepseek.v3.2` supports long-output batch inference (up to 81,920 output tokens). When images are attached, the manual pick must be a vision-capable model (validated at the route layer).

**External Tier-3 models** (auto-only escalation, e.g. `qwen3.7-flash-2026-07-15`, `MiniMax-M2.7-highspeed`) are **not** in this constant list — they are admin-managed rows in the `tier3_models` table (`GET/PUT /api/v1/admin/tier3`), keyed by the operator's OpenAI-compatible gateway (`TIER3_BASE_URL` / `TIER3_API_KEY` / `TIER3_ENABLED` env). Their per-1M prices live in `src/frontend/pricing-config.json` alongside the Bedrock models.

**Tier-3 tools & thinking (config allowlist):** models whose ID matches a prefix in `config.routing.externalTier3.toolModelPrefixes` (env `TIER3_TOOL_MODEL_PREFIXES`, default `deepseek-v4-`) get the ReAct tool registry (`get_current_datetime`) plus optional thinking params (`config.routing.externalTier3.thinkingParams`, env `TIER3_THINKING_PARAMS`, e.g. Qwen `{"enable_thinking":true}` — placement per gateway, confirm by spike first). `external-chat.service.ts` runs a bounded loop (≤3 iterations), streams `reasoning`/`tool_call`, sums tokens into one `metadata`, and persists **only the final non-empty content** — intermediate tool frames and reasoning never touch the DB or audit (see `docs/features/tier3-tools/`).

**Tier-1 internal tool loop (multi-hop RAG, default OFF):** gated by `TIER1_TOOLS_ENABLED` **and** `executedModelId === (TIER1_TOOLS_MODEL_ID || AUTO_MODEL_ID)` on the private-Bedrock JSON-text path — never on sovereign-tier-3 escalation (separate multipart handler too). When on, `generate()` runs an **additive** bounded loop (`runToolLoop`, see `docs/features/tier1-tools/`): ≤ `TIER1_MAX_TOOL_ITERATIONS` tool-capable rounds each carrying `toolConfig.tools=[search_internal_knowledge(query, doc_type?)]`, then one plain forced round with tools stripped. Each tool round streams a `tool_call` SSE, executes locally through the same semantic pgvector search Auto-RAG uses (`knowledge.service.search`; `execTier1Tool` → top `TIER1_TOOL_TOP_K` chunks **in full** — count-capped, never char-truncated), and re-invokes with the `toolResult` appended; text deltas stream live every round; tokens sum into a **single** final `metadata` + `done`. Auto-RAG injection, the sovereign-tier router, and Tier-3 escalation run **unchanged**; per-call audit metadata (`tool`/masked `args`/`duration_ms`/`result_chunks`/`result_size`) lands in `audit_logs.tool_calls_meta` (raw query/result never stored).

**Key invariant (Tahap 1):** Auto mode issues ZERO LLM routing calls — no classification, refinement, scoring, or verification. The model is fixed unless the user whitelist denies access. Phase 2 adds only two deterministic gates on top: the restricted-word/PII classifier (`classifySovereignTier`) and the post-retrieval empty-result escalation to Tier 3 — still zero LLM routing calls.


---

## 5. Session Memory (Three-Tier)

### Tier 1: Raw Recent Turns
- All messages stored in `messages` table per session
- `buildContext()` selects last N messages within char budget (default 640K)
- Default 20 turns max (`maxHistoryTurns`)

### Tier 2: Rolling Summary
- When messages are evicted from the window, `summarizeEvicted()` calls qwen3-32b to generate/update a rolling summary
- Summary is injected into the first history message's text as `[Previous conversation summary: ...]`
- Stored in `sessions.rolling_summary TEXT`
- Version tracked via `sessions.memory_version INT`

### Tier 3: Extracted Facts
- After each successful turn, `extractFacts()` calls qwen3-32b to extract key-value pairs
- Example: `{"budget": "50M IDR Q3", "deadline": "Sep 30", "approver": "Budi"}`
- Merged with existing facts (new values overwrite old for same key)
- Injected alongside summary as `[Extracted facts: budget=50M...]`
- Stored in `sessions.extracted_facts JSONB`

---

## 6. SSE Events Emitted During Inference

| Event | Timing | Data |
|---|---|---|
| `session` | Start of stream | `{ sessionId }` |
| `routing` | After routing | Trimmed `RoutingMetadataEvent`: routingState, executedModelId, routingReasonCode, modalityFlags, manualOverrideApplied, flags, routingDurationMs, prompt lengths, memory/facts (multipart: OCR model fields) |
| `embedding` | After knowledge retrieval | `{ inputTokens, chunks: [{ id, title, docType, score, bindingLevel, sourceType }] }` |
| `delta` | Per token | `{ type: "text", content: "<token>" }` |
| `reasoning` | Tier-3 external (thinking-capable model) | `{ content: "<reasoning token>" }` — forwarded per CoT token; never persisted/logged |
| `tool_call` | Tier-3 external ReAct round **or** Tier-1 tool round | `{ tools: ["get_current_datetime"] }` / `{ tools: ["search_internal_knowledge"] }` — once per tool round |
| `metadata` | End of stream | `{ inputTokens, outputTokens }` (Tier-3 external **and** Tier-1 tool loop: summed across iterations; single-shot = one call's usage) |
| `session_status` | On storage failure | `{ sessionId, is_degraded: true }` |
| `done` | End of stream | `{}` |
| `error` | On failure | `{ error, message }` |

`reasoning` fires only on the external Tier-3 path (see §4.3). `tool_call` fires on the external Tier-3 path **and** on the Tier-1 internal loop (default OFF, §4.3 "Tier-1 internal tool loop") — both additive; existing `delta`/`metadata`/`done`/`error` consumers parse unchanged. On Tier-1 tool turns, `delta`/`metadata`/`done` span the whole loop (tokens summed, one `metadata`/`done` at the end); on non-tool turns the stream is byte-identical to the pre-feature single shot.

**No verification/repair events** — deterministic output verification, the semantic judge, and auto-repair were removed in Tahap 1 along with the LLM router.

**Batch endpoint** does NOT use SSE — returns plain JSON `{ summary, decisions, actionItems, metadata }`.

---

## 7. Document Extraction Pipeline

### Format dispatch

```
extractDocumentText(file)
├── application/pdf                                                                  → extractPdfText() (raw text)
├── application/vnd.openxmlformats-officedocument.wordprocessingml.document          → extractDocxText() (mammoth→HTML→turndown→Markdown)
├── application/vnd.openxmlformats-officedocument.presentationml.presentation        → extractPptxText() (officeparser raw text)
├── application/vnd.openxmlformats-officedocument.spreadsheetml.sheet                → extractXlsxText() (SheetJS→Markdown tables)
├── application/vnd.ms-excel                                                         → extractXlsxText() (XLS fallback)
├── application/msword                                                               → convertViaGotenberg() (LibreOffice→PDF→text)
├── application/vnd.ms-powerpoint                                                    → convertViaGotenberg() (LibreOffice→PDF→text)
├── text/html                                                                        → extractHtmlText() (cheerio raw text)
├── application/json                                                                 → extractJsonText() (prettified + ```json block)
├── text/csv                                                                         → extractCsvText() (Markdown table, ≤500 rows)
├── text/markdown                                                                    → extractMarkdownText() (as-is)
├── text/plain                                                                       → extractPlainText() (as-is)
├── application/xml | text/xml                                                       → extractXmlText() (stripped text)
└── anything else                                                                    → throw
```

### OCR fallback & Document Text Injection

When extraction returns low-confidence text (image-heavy PDFs, PPTX), the two-stage OCR pipeline extracts the real content. The `effectiveDocText` variable ensures OCR output overrides the empty extraction text for all downstream consumers.

---

## 8. Two-Stage OCR Pipeline

```
needsOCR = images.length > 0 || documentBlocks.length > 0

if needsOCR:
  Stage 1: Nova Lite via InvokeModel (raw API, messages-v1 schema)
           - Processes image blocks + raw document blocks
           - Timeout: 60s, maxTokens: 4096
  
  Stage 2: GPT-OSS 120B enhances OCR output
           - Combines original prompt + OCR text
           - Full streaming response to client
  
  Fallback: If Nova fails or returns empty, GPT-OSS handles natively

  Model fallback: If GPT-OSS fails → fallback to original routing model (qwen3-235b)
```

---

## 9. Gotenberg — Legacy Office Conversion

### Purpose
Convert binary Office formats (.doc, .ppt) that pure Node.js cannot parse. Also powers the HTML-first PPTX/PDF generation pipeline via Chromium endpoints. Deployed as a separate Cloud Run service.

### Endpoints Used

| Endpoint | Used For |
|---|---|
| `/forms/libreoffice/convert` | Legacy .doc/.ppt → PDF → text extraction. JSON-path PPTX → PDF. |
| `/forms/chromium/convert/html` | HTML slides → PDF (native CSS rendering, perfect fidelity) |
| `/forms/chromium/screenshot/html` | HTML slides → PNG screenshots (1280x720) → JSZip PPTX |

### Flow
```
.doc / .ppt file uploaded
  → extractDocumentText() routes to convertViaGotenberg()
  → POST file to Gotenberg /forms/libreoffice/convert
  → Gotenberg returns PDF
  → extractPdfText() extracts text from PDF
  → Text returned as ExtractionResult

HTML slides (HTML path, default)
  → htmlToPptxViaGotenberg(): parse <section> → 5 concurrent Chromium screenshots → JSZip .pptx
  → htmlToPdfViaGotenberg(): Chromium /forms/chromium/convert/html → .pdf (native CSS)

JSON slides (JSON fallback)
  → convertPptxToPdf(): python-pptx .pptx → LibreOffice → .pdf (lossy)
```

### Deployment
| Setting | Value |
|---|---|
| Image | `gotenberg/gotenberg:8` |
| Resources | 2 vCPU / 4GB RAM |
| Env var | `GOTENBERG_URL` (set in Cloud Run) |

---

## 10. PII Masker

### Detected entities

| Entity | Pattern | Validation |
|---|---|---|
| NIK | 16-digit | Province code check |
| NO_HP | 08xx, +62, 62 | Operator prefix validation |
| NO_REKENING | 8-15 digit in banking context | Keyword proximity (rekening, transfer, etc.) |
| NAMA | Capitalized words after title prefixes | Exclusion list for common words |
| NAMA_BANK | Bank name dictionary | Fuzzy alias matching |

### Behavior
- Left-to-right resolution, longest match wins
- Indexed placeholders: `[NIK_1]`, `[NIK_2]`, etc.
- One-way masking — no unmasking step
- Fail-closed: if masker throws, inference rejected with 500
- Post-inference PII scan for batch endpoint (defense-in-depth — discards output if PII leaks)

---

## 11. Database Schema

### `users`
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| username | VARCHAR(64) | UNIQUE |
| password | VARCHAR(255) | bcrypt hash, nullable for Google users |
| role | VARCHAR(16) | 'admin' | 'user' |
| display_name | VARCHAR(128) | |
| force_password_reset | BOOLEAN | Default true |
| group_name | VARCHAR(255) | Organizational group |
| google_id | VARCHAR(255) | UNIQUE, nullable. Google OIDC sub claim |
| auth_provider | VARCHAR(16) | 'local' | 'google', default 'local' |
| created_at / updated_at | TIMESTAMPTZ | |

### `sessions`
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| user_id | UUID | FK → users |
| status | VARCHAR(16) | active | degraded | inactive | expired |
| turn_count | INTEGER | |
| rolling_summary | TEXT | Tier 2 memory |
| memory_version | INTEGER | Default 0 |
| extracted_facts | JSONB | Tier 3 memory |
| internal_document_context | TEXT | [v036] Masked Google Workspace document text — sticky internal context (≤50k); blocks Tier-3 for the whole session |
| internal_document_title | TEXT | [v036] Display title of that document |
| expires_at | TIMESTAMPTZ | |
| created_at / updated_at / last_activity_at | TIMESTAMPTZ | |

### `messages`
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| session_id | UUID | FK → sessions |
| role | VARCHAR(16) | 'user' | 'assistant' |
| sanitized_content | TEXT | PII-masked |
| storage_flags | JSONB | |
| created_at | TIMESTAMPTZ | |

### `audit_logs`
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| timestamp | TIMESTAMPTZ | |
| user_id, username | | Denormalized |
| model_id | VARCHAR(128) | |
| input_tokens, output_tokens | INTEGER | |
| status | VARCHAR(16) | 'success' | 'failed' |
| error_category | VARCHAR(32) | |
| duration_ms | INTEGER | |
| file_count, file_mime_types, total_file_size | | File metadata |
| is_multimodal | BOOLEAN | |
| routing_state, complexity_score, routing_reason_code | | Routing metadata |
| reasoning_summary | TEXT | |
| executed_model_id | VARCHAR(128) | |
| manual_override_applied | BOOLEAN | |
| modality_flags | JSONB | |
| routing_flags | TEXT[] | |
| session_id | UUID | |
| replayed_message_count, context_truncated, context_summarized | | Context stats |
| session_state | VARCHAR(16) | |
| turn_count | INTEGER | |
| model_pricing_snapshot | JSONB | Pricing at request time |
| orchestration_meta | JSONB | No longer written (Tahap 1) — column kept, always NULL |
| orchestration_group_id | UUID | No longer written (Tahap 1) — column kept, always NULL |
| orchestration_step_order | INTEGER | No longer written (Tahap 1) — column kept, always NULL |
| routing_context | TEXT | No longer written (Tahap 1) — column kept, always NULL |
| routing_intent | TEXT | No longer written (Tahap 1) — column kept, always NULL |
| session_context | TEXT | Session preview (first 120 chars of prompt) |
| billed_user_id | UUID | [v019] Organizer for cost attribution (bssmom/ghostmeet) |
| billed_group | VARCHAR(255) | [v019] Org group of billed user |
| api_key_used | BOOLEAN | [v019] True if X-API-Key auth was used |
| knowledge_sources | JSONB | [v025] Knowledge chunk IDs backing the response (audit traceability) |
| embedding_input_tokens | INTEGER | [v028] Retrieval-query embedding tokens per inference turn |
| api_key_id / application_id | UUID | [v023] Multi-tenant API-key context (nullable; replaces `api_key_used`) |
| tool_calls_meta | JSONB | [v034] Tier-1 tool-loop audit: `[{tool, args_masked, duration_ms, result_chunks, result_size}]` (args PII-masked at write time; raw never stored) |

### `feedback_reports`
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| session_id | UUID | |
| user_feedback | TEXT | User's complaint text |
| error_category | VARCHAR(32) | hallucination, missed_context, wrong_tone, formatting_issue, other |
| final_response | TEXT | The LLM output text |
| routing_metadata | JSONB | Enriched: routingState, model, executedModelId, complexityScore (legacy — null in Tahap 1), routingContext |
| alignment_summary | TEXT | LLM-generated root cause analysis |
| root_cause_analysis | TEXT | |
| recommendation | TEXT | |
| status | VARCHAR(20) | default 'pending' |
| reviewed_by | VARCHAR(64) | |
| reviewed_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

**Rich feedback:** When user submits feedback, the frontend captures the user prompt + routing status panel text, and the backend enriches from `audit_logs` (executed model, routing state). Stored in `routing_metadata` and fed to the synthesis LLM for root cause analysis.

### `knowledge_documents`  (v024, v026, v030)
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| source_file | VARCHAR(512) | Original filename |
| doc_type | VARCHAR(64) | CHECK: 19 types (SOP, MEMO, REGULATION, PRODUCT_FAQ, HKR, HUK, AUDIT, JUKNIS, BRD, FSD, PKS, UAT, SIT, PROJECT_CHARTER, IT_RD, HCP, CAB, ADR, SAF) |
| title | VARCHAR(512) | |
| chunk_index | INTEGER | 0-based within source doc |
| content | TEXT | Chunk (~1000 tokens) |
| content_hash | VARCHAR(16) | SHA-256 prefix — dedup key (indexed) |
| embedding | VECTOR(1536) | Cohere float; IVFflat cosine index (lists=100) |
| binding_level | VARCHAR(16) | CHECK: regulatory/contractual/procedural/directive/assessment/informational/other |
| source_type | VARCHAR(16) | CHECK: official / internal / hukumonline |
| sensitivity | VARCHAR(16) | CHECK: restricted / internal / public |
| metadata | JSONB | version, effective_date, expiry_date, domain[], jurisdiction[] |
| created_at | TIMESTAMPTZ | |

### `knowledge_ingestion_jobs`  (v027, v029)
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| source_file | VARCHAR(512) | |
| status | VARCHAR(16) | processing | completed | failed |
| chunks_indexed | INTEGER | |
| error | TEXT | |
| uploaded_by | VARCHAR(255) | [v029] Uploader identity |
| doc_type | VARCHAR(64) | [v029] Same CHECK as documents |
| binding_level / source_type / sensitivity | VARCHAR(16) | [v029] Same CHECKs as documents |
| created_at / completed_at | TIMESTAMPTZ | |

### `restricted_terms`  (v033)
| Column | Type | Notes |
|---|---|---|
| term | TEXT | PK — stored as written, matched lowercased (case-insensitive substring) |
| created_at | TIMESTAMPTZ | Default now() |

Admin-managed live lexicon: a substring hit on the masked prompt/doc text forces the request private (Tier 1) — it can never reach the external Tier-3 gateway. Seeded with bank sensitivity terms (`rahasia`, `confidential`, `internal`, `classified`, `rahasia bank`, `data pribadi`).

### `tier3_models`  (v032)
| Column | Type | Notes |
|---|---|---|
| model_id | TEXT | PK — e.g. `qwen3.7-flash-2026-07-15` |
| is_default | BOOLEAN | Default false (uniqueness enforced in `tier3.service` — admin-only table) |
| enabled | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | Default now() |

---

## 12. Configuration (Environment Variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `JWT_SECRET` | — | HS256 secret |
| `JWT_EXPIRES_IN` | 3600 | Token TTL (seconds) |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | localhost/5432/bedrock_gateway/postgres/— | PostgreSQL (GCP Cloud SQL) |
| `DB_SSL` | — | Set to 'false' to disable SSL |
| `AWS_REGION` | ap-southeast-3 | Bedrock region |
| `GOOGLE_CLIENT_ID` | — | Google OAuth client ID |
| `GHOSTMEET_API_KEY` | — | API key for M2M batch inference (timingSafeEqual) |
| `MAX_CONTEXT_CHARACTERS` | 640000 | Character budget for context window |
| `MAX_HISTORY_TURNS` | 20 | Max turns in sliding window |
| `SESSION_EXPIRY_HOURS` | 24 | Session TTL |
| `ROUTING_METADATA_ENABLED` | true | Emit routing SSE event |
| `AUTO_MODEL_ID` | qwen.qwen3-235b-a22b-2507-v1:0 | Fixed model for Auto mode (Tahap 1 deterministic — zero LLM routing) |
| `ROUTING_LONG_CONTEXT_THRESHOLD` | 8000 | Legacy (no consumer in Tahap 1) — parsed, unused |
| `ROUTING_SCORING_TIMEOUT_MS` | 5000 | Legacy (no consumer in Tahap 1) — parsed, unused |
| `ROUTING_REFINEMENT_TIMEOUT_MS` | 8000 | Legacy (no consumer in Tahap 1) — parsed, unused |
| `ROUTING_CLASSIFIER_TIMEOUT_MS` | 2000 | Legacy (no consumer in Tahap 1) — parsed, unused |
| `ROUTING_DEFAULT_FALLBACK_SCORE` | 2 | Legacy (no consumer in Tahap 1) — parsed, unused |
| `BATCH_MAX_PROMPT_LENGTH` | 262144 | Max prompt length for batch endpoint (256KB) |
| `BODY_LIMIT` | 10mb | JSON body parser limit (raised for long prompts) |
| `EXTRACTION_LOW_CONFIDENCE_THRESHOLD` | 100 | Chars below which confidence = 'low' |
| `EXTRACTION_MAX_JSON_DEPTH` | 20 | Max JSON nesting |
| `EXTRACTION_MAX_HTML_DEPTH` | 100 | Max HTML nesting |
| `EXTRACTION_MAX_CSV_ROWS` | 100000 | Max CSV rows |
| `EXTRACTION_MAX_PPTX_ENTRIES` | 2000 | Max PPTX ZIP entries |
| `GOTENBERG_URL` | — | Gotenberg service URL |
| `GOTENBERG_TIMEOUT_MS` | 30000 | Gotenberg conversion timeout |
| `PPTX_SERVICE_URL` | — | python-pptx microservice URL (internal Cloud Run) |
| `KNOWLEDGE_EMBEDDING_MODEL` | global.cohere.embed-v4:0 | Embedding model (cross-region Bedrock inference profile) |
| `EMBEDDING_TIMEOUT_MS` | 2000 | Timeout per embedding call (ms) |
| `KNOWLEDGE_EMBED_BATCH_SIZE` | 32 | Chunks embedded per Bedrock call during ingestion (≤96) |
| `EMBEDDING_BATCH_TIMEOUT_MS` | 15000 | Timeout for a batched ingestion embedding call (ms) |
| `KNOWLEDGE_SEARCH_TIMEOUT_MS` | 2000 | Knowledge retrieval timeout during inference (ms) |
| `KNOWLEDGE_CHUNK_SIZE` | 1000 | Ingestion chunk size (tokens, ~4 chars/token) |
| `KNOWLEDGE_CHUNK_OVERLAP` | 100 | Chunk overlap (tokens) |
| `KNOWLEDGE_TOP_K` | 5 | Max chunks injected into system prompt |
| `KNOWLEDGE_MIN_SCORE` | 0.4 | Cosine gate — chunks below this are "not covered" (not injected; empty result escalates a candidate to Tier-3). Calibrated: in-domain ≥0.40, out-of-domain ≤0.33 |
| `TIER3_ENABLED` | false | Enable external Tier-3 escalation (auto-tier-3, auto-only, text-only) |
| `TIER3_BASE_URL` | — | External OpenAI-compatible gateway base URL (e.g. `https://api.deepseek.com`) |
| `TIER3_API_KEY` | — | Gateway key — env-only, never written/returned by the app |
| `TIER3_TOOL_MODEL_PREFIXES` | deepseek-v4- | Comma-separated model prefixes offered ReAct tools + thinking params |
| `TIER3_THINKING_PARAMS` | {} | JSON extra top-level body params for allowlisted thinking models (e.g. `{"enable_thinking":true}`) |
| `TIER1_TOOLS_ENABLED` | false | Enable Tier-1 internal tool loop (multi-hop RAG) on the private-Bedrock JSON-text path — **default OFF, zero behavior change** |
| `TIER1_TOOLS_MODEL_ID` | — | Model allowlisted to receive tools — empty → routed auto model (`qwen3-235b`) |
| `TIER1_MAX_TOOL_ITERATIONS` | 3 | Max tool-capable rounds (loop = N tool rounds + 1 plain forced final round) |
| `TIER1_TOOL_TIMEOUT_MS` | 30000 | Per-tool timeout budget (reserved; search self-timeouts at `KNOWLEDGE_SEARCH_TIMEOUT_MS`) |
| `TIER1_TOOL_TOP_K` | 3 | Tool-result chunk **count** cap — each chunk returned in full, never char-truncated |
| `MIN_PASSWORD_LENGTH` | 8 | Minimum password length |

---

## 13. Testing

### Test runner
- Vitest with `globals: true`
- Path alias `@/` → `./src/`

### Test patterns
- **Service tests**: mock database via `vi.mock`, mock Bedrock via `vi.mock('@aws-sdk/client-bedrock-runtime')`
- **Pure function tests**: no mocking needed (context-assembly, content-builder, pii-masker)
- **Route tests**: `vi.mock` for all dependencies

### Test files (40 total, 542 tests)
```
tests/unit/
├── admin-applications.routes.test.ts
├── admin.middleware.test.ts
├── api-key-auth.middleware.test.ts
├── api-key.service.test.ts
├── app.test.ts
├── application.service.test.ts
├── audit.service.test.ts          # + billedUserId/billedGroup/apiKeyUsed params
├── auth-google.test.ts
├── auth.middleware.test.ts
├── auth.routes.test.ts
├── auth.service.test.ts
├── content-builder.test.ts
├── context-assembly.service.test.ts
├── cost-calculator.test.ts
├── cost-reporting.routes.test.ts
├── cost-reporting.service.test.ts
├── document-extractor.test.ts
├── embedding.service.test.ts      # batch generateEmbeddings (order, [], count/dim mismatch)
├── external-chat.service.test.ts  # Tier-3 SSE delta/usage/fallback, sanitized errors, plain body
├── external-chat-tools.test.ts    # ReAct: reasoning echo, tool-call index merge, cap, summed tokens, B1 guard
├── file-signature-validator.test.ts
├── image-processor.test.ts
├── inference-retry.test.ts
├── inference.routes.test.ts
├── inference.service.test.ts
├── knowledge.routes.test.ts       # upload 202, metadata extract, list, status
├── knowledge.service.test.ts      # chunk + hash-dedup + batch-embed index, semantic gate, delete
├── models.routes.test.ts
├── password-reset.middleware.test.ts
├── pii-detection.test.ts
├── pii-masker-nama.test.ts
├── pptx-generator.service.test.ts
├── restricted-terms.service.test.ts  # restricted-word lexicon CRUD + live-restrict behaviour
├── routing-engine.test.ts         # 17 tests (sovereign classify + auto/manual/passthrough + access-denied)
├── session-memory.test.ts
├── tier1-tools.service.test.ts    # Tier-1 loop: registry, top-K count-cap, doc_type filter, no-PII-mask, default-OFF anchor
└── tier3.service.test.ts          # tier3_models default resolution + CRUD
```
```

### Routing Engine Tests (deterministic)
`selectAutoModel()`: returns the configured fixed auto model when access is granted (zero LLM calls); falls back to DEFAULT_MODEL + `auto-access-denied` flag when denied. `routeRequest()`: auto → fixed model + raw prompt + `fallback` skill; manual preserves the user's model byte-for-byte; passthrough sets the `passthrough` flag. No LLM routing calls are asserted anywhere.

---

## 14. Auth Middleware

### JWT Bearer (interactive)
- `authMiddleware` validates JWT Bearer token from `Authorization` header
- Extracts `TokenPayload { sub, username, role }`
- Used by all interactive endpoints

### X-API-Key (machine-to-machine)
- `apiKeyAuthMiddleware` validates `X-API-Key` header via constant-time `timingSafeEqual`
- Resolves to `ghostmeet` system user UUID for audit attribution
- Used exclusively by `POST /api/v1/inference/batch` (GhostMeet integration)
- Fail-closed: returns 500 if `GHOSTMEET_API_KEY` not configured
- Always sets `apiKeyUsed: true` in audit logs

---

## 15. Batch Inference Endpoint

### Purpose
Non-streaming, machine-to-machine inference for bulk processing (GhostMeet → beexexity). Designed for meeting transcript summarization.

### Request
```
POST /api/v1/inference/batch
X-API-Key: <secret>
Content-Type: application/json

{
  "prompt": "Meeting transcript text (up to 256KB)...",
  "modelId": "deepseek.v3.2",
  "config": { "maxTokens": 8192, "temperature": 0.3 },
  "billingContext": { "billedUserId": "uuid", "billedGroup": "org-name" },
  "responseFormat": "json"
}
```

### Response
```json
{
  "summary": "Executive summary...",
  "decisions": ["Decision 1", "Decision 2"],
  "actionItems": [
    { "task": "Prepare requirement doc", "owner": "[NAMA_1]" }
  ],
  "metadata": {
    "modelId": "deepseek.v3.2",
    "inputTokens": 1200,
    "outputTokens": 800,
    "durationMs": 45000,
    "piiMasked": true,
    "hasPostInferencePiiScan": true,
    "postInferencePiiIssues": 0
  }
}
```

### Key differences from interactive flow
- No session, no streaming, no SSE
- Manual routing only (modelId is required)
- Post-inference PII scan (defense-in-depth — discards output if PII leaks)
- Structured JSON output with markdown fallback parser
- Billing context for cost attribution
- Larger body parser limit (512KB)

---

## 16. Important Patterns

- **Deterministic auto routing (Tahap 1)**: Auto mode = `selectAutoModel()` → one fixed model (`config.routing.autoModelId`, default qwen3-235b). Zero LLM routing calls; skill always `fallback`; raw prompt passed through unchanged.
- **Single-shot dispatch**: Every request runs a single `generate()` (Bedrock ConverseStream). Sequential reasoning, deterministic/semantic verification, and auto-repair were removed in Tahap 1.
- **Reason-code seam**: `routingReasonCode` + `flags` on `RoutingDecision` stay populated (`auto-fixed-model`, `auto-access-denied`, `manual-override`, `passthrough`) as the Phase-2 injection point (3-gate Tier-3 router enters at `selectAutoModel`).
- **Access-denied fallback**: If the user whitelist denies the fixed auto model, routing degrades to `DEFAULT_MODEL` (qwen3-32b) with an `auto-access-denied` flag — never a hard error.
- **Rich feedback**: Feedback submission includes the user's original prompt + routing status-panel text, enriched server-side from `audit_logs` (model, routing state) for root-cause synthesis.
- **Indent-aware markdown rendering**: List items track indentation level via a stack, producing proper nested HTML.
- **Fail-closed PII**: If masker throws, inference rejected (500). Never sends unmasked data. Post-inference PII scan for batch endpoint.
- **API key auth**: Constant-time comparison via `timingSafeEqual`. Resolves to `ghostmeet` system user.
- **Passthrough mode (Standard Mode)**: Admin-toggleable global setting that forces `routingState='passthrough'` — raw prompt, minimal system prompt, `passthrough=true` audit flag. Stored in `app_config` table with in-memory cache. Chat UI shows read-only banner.
- **Session preview from assistant response**: Session sidebar preview uses first assistant message (not user prompt) — better UX for document uploads where prompt is just "jelaskan dokumen ini".
- **Markdown format instruction**: The system prompt always appends `FORMAT_INSTRUCTION` (7 explicit markdown rules) — clean markdown output across auto/manual/passthrough.
- **Emoji heading detection**: Frontend parser treats emoji-prefixed lines (🔹, ✅, etc.) as `<h3>` when the content looks like a title — catches non-standard heading patterns.
- **List-aware heading closing**: When a `###` heading, `---` HR, or emoji heading appears inside a list context, the list is automatically closed before rendering the heading.
- **Surrogate pair support**: Emoji detection regex uses the `u` flag for proper Unicode surrogate pair handling (SMP emojis like 🔹, 🏢).
- **No full content logging**: Audit logs record metadata only.
- **Sanitized errors**: Bedrock errors sanitized — no ARNs, request IDs, or stack traces.
- **Pricing snapshots**: Model pricing captured at inference time for historical accuracy.
- **Billing context**: `billed_user_id`/`billed_group` for per-organizer cost attribution (bssmom/GhostMeet integration).
- **OCR enhancement override**: The multipart needsOCR path overrides the routed model with GPT-OSS 120B (Stage 2 enhance); falls back to the routed model if enhance fails.
- **File buffer cleanup**: After multipart inference, file buffers explicitly nullified.
- **Cache-control on HTML**: HTML files served with `Cache-Control: no-cache, no-store, must-revalidate`.
- **EventEmitter limit**: `EventEmitter.defaultMaxListeners = 50` in `server.ts`.
- **Google OAuth JIT provisioning**: `loginWithGoogle()` verifies Google ID token server-side, then JIT-provisions via 3-step process.
- **HTML-first slide generation with dynamic theming**: LLM acts as Presentation Art Director — selects one of 10 CSS Variable-based themes based on document context, outputs only `<section>` elements. Node.js injects `<head>` with full theme CSS before Gotenberg Chromium rendering. 7 layout classes (hero, split, bento-3, bento-4, timeline, quote, content) with deterministic validation (theme consistency, layout diversity, structure). JSON path preserved as fallback for editability.
- **Local dev slide preview**: When Gotenberg is unavailable, the generation endpoint returns wrapped HTML directly — open in browser to preview themed slides without PPTX conversion.
- **Clipboard paste for files**: Paste handler on chat input detects files from clipboard (Finder/Explorer copy) — pastes as file attachments via existing `handleFileSelection()` flow. Text paste unaffected.
- **Render beautification**: Custom markdown parser with callout/admonition boxes (emoji-prefixed: 💡⚠️🚨), task list checkboxes (`- [ ]` → ☐, `- [x]` → ☑), typography tuning (SF Pro Display/Inter, 1.6 line-height, 80ch max-width), reduced list borders, suppressed `<br>` spacing.
- **Auto-fallback generation**: PPTX/PDF endpoints auto-detect Gotenberg availability — use HTML/CSS path when deployed, fall back to JSON/python-pptx locally. Query param `?format=html|json` overrides auto-detection.
- **Conversation context in file generation**: Frontend collects last 4 user-assistant turns from chat DOM, backend injects them as "KONTEKS PERCAKAPAN SEBELUMNYA" — enables multi-turn drafting before final file generation.
- **Auto-download + clickable link**: Generated files auto-download AND show a clickable download link in chat. Blob URL kept alive until next generation. File size displayed in MB.
- **python-pptx service scale-to-zero**: Deployed as separate Cloud Run service with min-instances=0, internal-only ingress, IAM auth. Cold start ~2s acceptable for generation latency.
- **Knowledge retrieval (Tier 2)**: Every JSON text inference turn embeds the effective prompt (Cohere) and retrieves top-K chunks into the system prompt with a citation rule; 2s self-timeout, any failure degrades to `[]` (inference never blocked).
- **Knowledge ingestion batching**: content-hash dedup via `content_hash = ANY($1::text[])`, then batch embed (default 32/call, ≤96) — a large PDF indexes in a handful of Cohere calls, not one per chunk.
- **Relevance-first ordering**: retrieval sorts by cosine distance first; the 7-value `binding_level` CASE (regulatory/contractual first) only breaks distance ties. (Ranking binding before similarity hid the most relevant non-regulatory chunk behind regulatory rows — e.g. the functional-spec answer to "jelaskan aplikasi digivisit" lost to irrelevant FAQ rows — which wrongly emptied retrieval and spurious-escalated in-domain questions to Tier-3.)
- **Semantic relevance gate (knowledge)**: retrieval is pure semantic — chunks below `KNOWLEDGE_MIN_SCORE` (default 0.4) are dropped, so irrelevant/out-of-corpus queries return `[]` (→ Tier-3 escalation). No keyword fallback: a fallback previously resurrected one broad FAQ chunk for any weak-semantic query via generic word overlap, so retrieval was never empty and escalation never fired.
- **Tier-3 ReAct loop (allowlisted)**: external models matching `TIER3_TOOL_MODEL_PREFIXES` (default `deepseek-v4-`) get `AVAILABLE_TOOLS` + optional `TIER3_THINKING_PARAMS`. Bounded ≤3 iterations; full assistant frames (content + `reasoning_content` verbatim + `tool_calls`) echo in-memory only; reasoning streamed as `reasoning` SSE but **never persisted/logged**; only the final non-empty content is stored; usage summed → one `metadata`/audit row; B1 empty-content (reasoning burned the budget) → sanitized error, no empty DB row.
- **Runtime config overrides**: `GET/PUT /api/v1/admin/env` mutates the live `config` singleton for `KNOWLEDGE_MIN_SCORE`, `ROUTING_METADATA_ENABLED`, `TIER3_ENABLED` (admin Config tab, "Env Overrides") — used for knowledge-score backtesting without a redeploy.

---

## 17. Knowledge Layer (Tier 2)

Bank-internal document RAG over pgvector (Cohere Embed v4, 1536-d). Ingested docs are chunked, embedded, and injected into the inference system prompt with citations.

### Retrieval flow (inference — JSON text path)
1. Embed the effective prompt (`input_type=search_query`).
2. Cosine top-K over `knowledge_documents` (`<=>`) sorted by distance first, `binding_level` as distance tiebreak.
3. Rows below `KNOWLEDGE_MIN_SCORE` (default 0.4) dropped — no keyword fallback. Irrelevant/out-of-corpus queries return `[]`.
4. Empty result → prompt sent unchanged (graceful degradation); on a `tier3-candidate` this empties the retrieval and triggers `auto-tier-3` escalation to the external gateway.
5. Non-empty → system prompt gets the reference block + citation rule `[Sumber: {title}, {section}]`; SSE `embedding` event emitted.
6. Audit traceability: `audit_logs.knowledge_sources` (chunk ids) + `embedding_input_tokens` (embed spend).

Self-timeout 2s — inference is never blocked; any failure degrades to `[]`.

### Ingestion (Admin UI / API / CLI)
- `POST /api/v1/knowledge/documents` — async (202); status tracked in `knowledge_ingestion_jobs`.
- `POST /api/v1/knowledge/metadata/extract` — qwen3-235b suggests doc_type/binding_level/sensitivity.
- `GET /api/v1/knowledge/documents` — job list; `GET /documents/:id/status` — poll. Auth: `x-api-key` OR JWT.
- CLI batch: `npx tsx src/scripts/ingest-knowledge.ts <folder>`.
- Pipeline: extract → Markdown → chunk (~1000 tokens, 100 overlap) → content-hash dedup → batch embed (32/call) → insert.
- Classification (migration 030): CHECK-constrained 19 `doc_type` / 7 `binding_level` / 3 `source_type` / 3 `sensitivity` on both `knowledge_documents` and `knowledge_ingestion_jobs`; legacy values normalized.

### Models & cost
- `global.cohere.embed-v4:0` — cross-region Bedrock inference profile (bare `cohere.embed-v4:0` rejected in ap-southeast-3).
- Ingestion cost: chunk count × batch calls. Inference cost: 1 query embed per JSON text turn (see §12 `KNOWLEDGE_*` / `EMBEDDING_*`).

### Scope note
Retrieval is wired on the JSON text-only inference path. The multipart file-upload path (§3.4) does not run knowledge search yet.

## 18. Google Workspace Integration

Users paste Google Docs / Sheets / Slides / Drive file URLs into chat. The URL interceptor (`url-interceptor.service.ts`) runs after model validation and before PII masking: it detects GWS URLs (code-block URLs ignored), fetches content via the user's Drive OAuth token, and replaces the URL with a `[Google {type}: {title}]` placeholder. Doc text and prompt are PII-masked **separately**, then `maskedPrompt + maskedDocumentText` feeds the sovereignty gate — a clean doc routes normally, a doc with PII/restricted lexicon forces `auto-tier-1` (private Bedrock, `sovereign-tier-1`). Extracted content is injected into the system prompt as document context. Every fetch is recorded in `audit_logs.orchestration_meta` (`action: 'gdrive_fetch'`, fileId, mimeType, durationMs).

**Folder links** (`drive.google.com/drive/folders/{id}`, incl. `/drive/u/{n}/folders/{id}`) are also supported: `fetchFolder()` in `google-drive.service.ts` lists the folder's children (`files.list`, `'{id}' in parents and trashed=false`, paginated), descends **one** nested level, and fetches each file with the same `fetchDocument()` path. Documents are joined into one blob under `===== n. {name} =====` headers and injected as a single `[Google Folder: {name}]` context — downstream inference is unchanged (one `extractedDocumentText`). Crawl limits: **≤20 files**, **≤50MB total**, **≤10MB per file**; fetch batches of 4 run via `Promise.allSettled`, so an oversized/unreadable/failed file is skipped rather than failing the turn. An empty or fully-unreadable folder yields `"Folder kosong atau tidak ada dokumen yang bisa dibaca."` rather than silence. Audit logs the folder name/id as `fileName`/`fileId`.

**Sticky internal document context (session-scoped).** A fetched GWS document is *internal material*, so it becomes part of the session: `inference.routes.ts` persists the **masked** extraction via `setInternalDocumentContext()` (`sessions.internal_document_context` / `_title`, v036, ≤50k chars) on the fetching turn. Every later turn reads it back as `effectiveDocumentText` (`maskedDocumentText ?? session.internal_document_context`), which (a) feeds `routingInput.maskedDocumentText` so `selectAutoModel` never sets `tier3-candidate` and `classifySovereignTier` still scans the document for PII/restricted terms, and (b) is injected into the system prompt so follow-ups can actually answer about it. Without this, a follow-up (which carries no URL) had no document signal at all — it escalated to the external Tier-3 gateway on empty retrieval **and** was answered without the document. Audit flag: `sovereign-internal-document`. A later turn that pastes a new document replaces the stored context.

New env vars (§12): `GOOGLE_DRIVE_CLIENT_ID` (OAuth 2.0 Web Client, distinct from the GIS login `GOOGLE_CLIENT_ID`), `GOOGLE_CLIENT_SECRET`, `GOOGLE_DRIVE_TIMEOUT_MS` (default 10000).

Auth endpoints (all under `/api/v1/auth/google-drive/`): `GET status`, `GET auth` (OAuth URL), `GET callback` (code→token, serves popup postMessage), `DELETE revoke`.

### Accepted risks (documented per design)
- **No app-level token encryption.** Refresh tokens sit in `user_google_drive_tokens` plaintext; protection relies on GCP Cloud SQL at-rest encryption + IAM. An env-var encryption key shares the same threat model as the DB password — accepted for MVP (see migration 035 comment).
- **In-memory access-token cache** (Map, TTL 50 min) is per-instance, not distributed — sufficient for Cloud Run's ≤10 instances; each instance may refresh independently.
- **No Drive rate limiter** — default quota (100 req/100s/user) monitored; add a limiter only if needed.
- **Zero-trust egress** — every Drive call uses the requesting user's token, never a service account.
