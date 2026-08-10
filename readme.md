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
| Default model | Qwen3 235B A22B | Previously Auto (now user-facing default)

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
│   │                         # + GET/PUT /config (passthrough_mode)
│   │                         # + GET/POST /discovered-roles (accept/reject/deploy)
│   ├── admin-applications.routes.ts  # CRUD /applications, CRUD /applications/:id/keys, PUT /keys/:id, DELETE /keys/:id
│   ├── models.routes.ts      # GET / (available models with pricing)
│   ├── inference.routes.ts   # POST /generate (SSE streaming + grounding + semantic judge), POST /batch (multi-tenant API key auth, x-username header)
│   │                         # + GET /sessions/active, POST /sessions/reset
│   ├── generation.routes.ts  # POST /pptx, POST /pdf (document HTML for PDF, slide HTML for PPTX, multipart, context injection)
│   ├── session.routes.ts     # GET /, GET /:id/messages, GET /:id/stats, POST /:id/resume
│   └── feedback.routes.ts    # POST / (submit), GET/PUT /admin (admin review + synthesis)
├── services/
│   ├── auth.service.ts           # Login, JWT sign/verify, user CRUD, Google OAuth
│   ├── session.service.ts        # Session lifecycle, messages CRUD, stats
│   ├── inference.service.ts      # Bedrock ConverseStream/Converse/InvokeModel, retry, SSE, OCR, repair, semantic judge (all skills)
│   ├── routing-engine.service.ts # 24-skill classifier + refinement + complexity scoring + policy + verification
│   │                            # + validateSkillInvariants() post-classification guard (10 rules)
│   ├── routing-policy.service.ts # Model selection: manual→long→vision→text
│   ├── sequential-reasoning.service.ts  # Multi-step planner→executor→synthesizer for complex queries
│   ├── pii-masker.service.ts     # Indonesian PII detection (NIK, HP, rekening, nama, bank)
│   ├── context-assembly.service.ts    # Sliding window, char budget, routing_payload, summary+facts injection
│   ├── session-memory.service.ts      # Load memory state, summarize evicted, extract facts
│   ├── content-builder.service.ts      # Ordered content blocks for Bedrock Converse
│   ├── document-extractor.service.ts   # PDF, DOCX, PPTX, XLSX, HTML, JSON, CSV, TXT, MD, XML (output: Markdown)
│   ├── image-processor.service.ts      # Image buffer → base64 content block
│   ├── upload-validator.service.ts     # Classify files → documents/images, MIME checks
│   ├── audit.service.ts                # Fire-and-forget audit logs + api_key_id + application_id FKs
│   ├── cost-reporting.service.ts       # Per-user cost aggregation + application/api-key filters
│   ├── config.service.ts               # App config (passthrough_mode) with DB + in-memory cache
│   ├── application.service.ts          # Multi-tenant application CRUD (admin-only)
│   ├── api-key.service.ts              # API key generate (bex_ + 32 hex, SHA-256), validate, CRUD, timingSafeEqual
│   ├── few-shot-library.ts             # Per-skill golden examples for format adherence
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
│   ├── inference.types.ts       # + SequentialStep, SequentialPlan, StepResult, SequentialOrchestrationMeta
│   ├── routing.types.ts         # 24 skills, PromptContract with behavioral_instructions & output_format
│   ├── pii.types.ts
│   ├── upload.types.ts          # DocumentFile, ImageFile, ExtractionResult, ContentBuildInput, ContentBlock
│   ├── audit.types.ts           # + apiKeyId, applicationId (deprecates apiKeyUsed)
│   ├── pptx.types.ts           # Content JSON schema for JSON fallback path (6 slide types), HTML path uses CSS layouts
│   ├── pricing.types.ts
│   ├── reporting.types.ts       # + applicationId, applicationName, apiKeyId, keyPrefix on UserCostReport
│   └── error.types.ts
└── scripts/
    └── run-migrations.ts    # Idempotent migration runner (creates _migrations table)

data/                            # Runtime data (not committed to git)
├── fallback-roles.ndjson         # Raw discovery log for novel fallback roles
└── discovered-roles-state.json   # Accept/reject/deploy state per role

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
└── 023_alter_audit_logs.sql        # Multi-tenant: api_key_id, application_id FKs, nullable username

tests/
└── unit/                           # 30 test files, 414 tests
    ├── api-key.service.test.ts     # 13 tests (generate, hash, validate, deactivate, delete)
    ├── application.service.test.ts # 12 tests (CRUD, duplicate rejection, key_count)
    ├── api-key-auth.middleware.test.ts  # 8 tests (6 auth scenarios + error paths)
    ├── admin-applications.routes.test.ts # 10 tests (CRUD endpoints)
    ├── routing-engine.test.ts      # 14 tests
    ├── sequential-reasoning.test.ts # 16 tests
    └── ... (25 other test files)

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
│   ├── mcp-knowledge-layer/     # MCP knowledge layer (Tier 2) — next major feature
│   ├── model-access/            # Model access control design
│   ├── multi-tenant-api-key/    # Multi-tenant API key feature
│   ├── passthrough-mode/        # Passthrough mode feature
│   ├── pptx-generation/         # PPTX/PDF generation feature
│   ├── sequential-reasoning/    # Sequential reasoning feature
│   ├── sub-agent/               # Sub-agent orchestration design
│   └── thinking-mode/           # Thinking mode requirements
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
├── admin.html                      # Admin dashboard — 7 tabs: Applications & Keys, Bulk Upload, Usage & Cost, Config, Model Access, Feedback, Discovered Roles
└── index.html                      # SPA frontend — SSE streaming with progressive render (rAF-throttled), grounding instruction, semantic judge
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
  14. Routing engine:
      a. Determine routingState: 'auto' | 'manual'
      b. If 'auto' → routeRequest():
         - unifiedClassifyAndScore()  — single LLM call: skill + complexity + language
         - validateSkillInvariants()  — 10 deterministic rules, zero LLM cost
         - refinePrompt()            — skill-aware or follow-up refinement
         - resolvePolicy()           — model selection
         → RoutingDecision
      c. If 'manual' → build RoutingDecision directly, skip routing
  15. Emit SSE events:
      event: session      { sessionId }
      event: routing      { skill, flags, timing, ... }
  16. Unified dispatch:
      complexity >= 4 AND routingState !== 'manual'
      → SequentialReasoner.execute()
         - planner() → 2-6 step plan (returns null → fallback to generate)
         - Emit orchestration_plan SSE
         - executor() + synthesizer() + progressiveSynthesis()
         - Each step passes language system prompt (e.g. "Respond in indonesian")
         - Emit delta + done events
      → else: generate() — Bedrock ConverseStream, SSE delta/metadata/done
  17. verifyOutput()         — deterministic checks against PromptContract
  18. Semantic verification  — semanticJudge() for high-stakes skills
      → event: semantic_verdict (if failed)
  19. Auto-repair (if verification fails) → repairResponse() → event: repair
  20. Emit done (sequential reasoning paths only)
  21. Store assistant msg    — PII-masked, increment turnCount
  22. Extract facts          — extractFacts() → update extracted_facts JSONB
  23. Audit log              — metadata-only, fire-and-forget
  24. Memory update          — if messages evicted, summarizeEvicted() → rolling_summary
  25. Release turn lock
```

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

When admin enables "Standard Mode" via the admin dashboard, ALL requests bypass routing/refinement.
Triggered by global config flag `app_config.passthrough_mode = true`.

```
Client → POST /api/v1/inference/generate
  Same as JSON flow, except:

  4b. Check global passthrough — configService.getPassthroughMode() (cached in-memory)
  4c. If enabled → force routingState = 'passthrough'
  9b. routeRequest() returns minimal decision (skill=fallback, no contract, no refinement)

  11b. System prompt: "You are a helpful assistant. Respond in {lang}."
       + FORMAT_INSTRUCTION (7 explicit markdown rules)

  12b. NO few-shots injected
  13c. Skip sequential reasoning
  14d. NO verification/repair
  15e. Audit with passthrough=true flag
  16f. Chat UI shows "⚡ Standard Mode" banner (read-only)
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
  5k. Unified dispatch: complexity >= 4 → SequentialReasoner, else → generate()
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
  maskedDocumentText?: string;      // PII-masked extracted document text
  hasImages: boolean;
  imageModelRequired: boolean;
  routingState: 'auto' | 'manual';
  manualModelId?: string;           // Set when user manually selects a model
  userId: string;
  conversationContext?: string;     // Last 2 user messages + last assistant, ≤ 500 chars
}
```

#### Output (`RoutingDecision`)

```typescript
interface RoutingDecision {
  executedModelId: string;
  routingState: 'auto' | 'manual';
  complexityScore: number;          // 1-5
  scoreBand: 'direct-answer' | 'moderate-reasoning' | 'advanced-reasoning';
  confidence: number;               // 0.0-1.0 from scoring LLM
  refinedPrompt: string;            // Skill-refined prompt or original fallback
  routingReasonCode: string;
  reasoningSummary: string;
  modalityFlags: ModalityFlags;
  manualOverrideApplied: boolean;
  flags: string[];                  // e.g. ['skill-demoted:code→fallback', 'refinement-failed']
  skill: SkillType;
  contract: PromptContract | null;
  detectedLanguage?: string;        // e.g. "indonesian", "english"
  sessionContext?: string;          // Short classifier reasoning for session row
  routingDurationMs?: number;
  classificationDurationMs?: number;
  refinementDurationMs?: number;
  scoringDurationMs?: number;
}
```

#### Step-by-step process

```
routeRequest(input)
│
├── [GUARD] routingState === 'manual'?
│     ├── resolvePolicy({ manual: true, manualModelId }) → modelId
│     └── return RoutingDecision (no refinement/scoring)
│
└── routingState === 'auto'?
      │
      ├── 1. UNIFIED CLASSIFY + SCORE  (unifiedClassifyAndScore)
      │     ├── Single qwen3-32b call: returns { skill, complexityScore, language }
      │     ├── Silent upload (files, no prompt) → fallback (no LLM call)
      │     └── Document snippet: first 2000 chars + last 1000 chars (head+tail)
      │
      ├── 2. INVARIANT CHECK  (validateSkillInvariants)
      │     ├── 10 deterministic rules, zero LLM cost
      │     ├── compliance_pre_assessment → requires legal/financial context
      │     ├── risk_analyst             → requires risk/threat context
      │     ├── data_analysis            → requires data/statistical context
      │     ├── code                     → requires ``` or code keywords
      │     ├── process_optimization     → requires process/workflow context
      │     ├── credit_analyst           → requires credit/financial context
      │     ├── meeting_summary          → requires meeting/transcript context
      │     ├── cloud_security           → requires cloud/infrastructure context
      │     ├── it_specialist            → requires IT/system context
      │     └── → demotes to fallback if rule fails, emits flag
      │
      ├── 3. PROMPT REFINEMENT  (refinePrompt)
      │     ├── Turn 1: SKILL_REFINEMENT_PROMPT (generic template with {{skill}})
      │     ├── Turn 2+: FOLLOW_UP_REFINEMENT_PROMPT (minimal, no role/context)
      │     ├── → PromptContract { role, context, task, intent, behavioral_instructions, output_format }
      │     └── Static role from SKILL_TO_ROLE overrides LLM-generated role
      │
      ├── 4. LONG CONTEXT CHECK
      │     └── > 8000 chars prompt+document → override model selection
      │
      ├── 5. POLICY RESOLUTION  (resolvePolicy)
      │     ├── Manual → honor user's selected model
      │     ├── Long context → qwen3-235b
      │     ├── Vision + score 1-3 → GPT-OSS 120B
      │     ├── Vision + score 4-5 → qwen3-235b
      │     └── Text (any score) → qwen3-235b
      │
      └── 6. RETURN RoutingDecision
            └── includes skill, complexity, flags, contract, language, sessionContext
```

### 4.2 The 24 Skills (6 groups)

```
Generation:    business_writing | creative_writing | brainstorming | prompt_optimizer
Transformation: summarization | translation | data_transformation | editing
Interaction:   roleplay | logic_math | planning_strategy | document_analysis
Enterprise:    requirement_generation | compliance_pre_assessment | risk_analyst
               | process_optimization | credit_analyst | meeting_summary
Engineering:   code | log_troubleshooting | data_analysis | cloud_security
               | it_specialist | fallback
```

**Expansion history:** Originally 17 skills, expanded to 19 (renames + redistribution), then 24:
- `document_analysis` added back (it's a cognitive task, not just a medium)
- `credit_analyst` — credit/financial/SLIK assessment
- `cloud_security` — cloud security and infrastructure analysis
- `it_specialist` — IT system and technical documentation analysis
- `meeting_summary` — meeting transcript summarization with structured JSON output (summary, decisions, action items)

### 4.3 Refinement — Two Modes

| | Turn 1 (no conversationContext) | Turn 2+ (has conversationContext) |
|---|---|---|
| Prompt | `SKILL_REFINEMENT_PROMPT` (generic template with role/context/task/intent) | `FOLLOW_UP_REFINEMENT_PROMPT` (task + intent only, no role/context) |
| LLM input | Original prompt + document context | Original prompt + conversation history |
| Output JSON | Full `PromptContract` including role + behavioral_instructions + output_format | Minimal: task + intent + ambiguities |
| Language | Detected language injected via `{{detected_language}}` | Same language detected from input |

**Role override:** LLM-generated role is always replaced with the static role from `SKILL_TO_ROLE`. The LLM-generated role is still logged and, if `skill === 'fallback'` and the role differs from the static one, appended to `data/fallback-roles.ndjson` for the Discovered Roles admin feature.

### 4.4 Routing Policy

```
resolvePolicy(input):
  1. Manual state        → honor user's selected model
  2. Long context        → qwen.qwen3-235b-a22b-2507-v1:0
  3. Vision + score 1-3  → openai.gpt-oss-120b-1:0
  4. Vision + score 4-5  → qwen.qwen3-235b-a22b-2507-v1:0
  5. Text (any score)    → qwen.qwen3-235b-a22b-2507-v1:0
```

**Key invariant**: qwen3-32b is NEVER used for inference — reserved for routing engine tasks (classification, refinement, scoring, progressive synthesis).

### 4.5 Allowed Models

| Model ID | Vision | Max Output Tokens | Role |
|---|---|---|---|
| `amazon.nova-lite-v1:0` | Yes | 5,120 | OCR extraction via InvokeModel |
| `openai.gpt-oss-120b-1:0` | Yes | 16,384 | Vision inference (low-mid complexity) |
| `qwen.qwen3-235b-a22b-2507-v1:0` | Yes | 8,192 | Primary inference + sequential reasoning |
| `qwen.qwen3-32b-v1:0` | Yes | 8,192 | Routing engine + progressive synthesis |
| `anthropic.claude-sonnet-5` | Text-only | 8,192 | Alternate text inference |
| `zai.glm-5` | Text-only | 8,192 | Alternate text inference |
| `deepseek.v3.2` | Text-only | 81,920 | Long-output inference (e.g. batch meeting summaries) |

`deepseek.v3.2` was added to support long-output batch inference (up to 81,920 output tokens for meeting transcripts).

### 4.6 Structured Format Templates

Some skills have deterministic output format templates via `getDefaultFormatTemplate()`:

- **requirement_generation** — natural headings for PRD/BRD
- **meeting_summary** — structured JSON: `{ summary, decisions, actionItems }`
- Other structured skills: compliance, risk_analyst, process_optimization, credit_analyst, code, log_troubleshooting, data_analysis, cloud_security, it_specialist, editing, document_analysis, planning_strategy, logic_math

---

## 5. Sequential Reasoning (Complex Mode)

### Trigger

```
complexityScore >= 4 AND routingState !== 'manual'
```
Not restricted to specific skills — any request with complexity >= 4 qualifies.

### Architecture

```
SequentialReasoner.execute(input, res)
  ├─ planner()
  │   ├─ Calls qwen3-235b (routed model)
  │   ├─ Structured JSON output: { steps: [{ name, description, systemPrompt }] }
  │   ├─ Constraints: 2 <= steps <= MAX_SEQUENTIAL_STEPS (default 6)
  │   ├─ Map-reduce: if document > LARGE_DOCUMENT_THRESHOLD (50K), force Step 1 = Data Cruncher
  │   ├─ Language preservation: planner prompt tells model to preserve user's language
  │   └─ On failure or <2 steps → returns null (fallback to single-shot)
  │
  ├─ emitPlanSSE()        → event: orchestration_plan
  │
  ├─ executor(plan)
  │   ├─ accumulatedContext initialized with document text (capped at 50K) + conversation history
  │   ├─ For each step:
  │   │   ├─ PII mask step input (fail-closed)
  │   │   ├─ Bedrock ConverseCommand (non-streaming) with language system prompt
  │   │   ├─ Retry up to STEP_RETRY_COUNT (tiered: same prompt → simplified)
  │   │   ├─ Skip step if all retries exhausted, emit orchestration_error
  │   │   ├─ PII mask step output (fail-closed)
  │   │   ├─ Append to accumulated context
  │   │   ├─ Audit per step: fire-and-forget with orchestration_group_id
  │   │   └─ Every PROGRESSIVE_INTERVAL steps → progressiveSynthesis()
  │   └─ → stepResults[]
  │
  ├─ synthesizer()
  │   ├─ ALWAYS runs, even if all steps fail
  │   ├─ Success case: formats accumulated context into cohesive narrative
  │   ├─ Partial case: best-effort response, acknowledges skipped steps
  │   ├─ Failure case: direct response from original prompt
  │   ├─ Uses qwen3-235b (routed model) with language system prompt
  │   └─ → synthesisStatus: 'success' | 'partial' | 'failed'
  │
  ├─ progressiveSynthesis()
  │   ├─ Every PROGRESSIVE_INTERVAL steps (default 3)
  │   ├─ Quick LLM call via qwen3-32b
  │   ├─ → event: orchestration_interim { step, total, insight }
  │
  └─ → SequentialReasoningResult { assistantText, plan, stepResults, synthesisStatus, orchestrationMeta }
```

### SSE Events (Orchestration)

| Event | When | Data |
|---|---|---|
| `orchestration_plan` | After planner | `{ steps: [{ order, name, description }], reasoning }` |
| `orchestration_status` | Per step | `{ step, total, name, description, status: 'running'|'completed'|'failed', durationMs? }` |
| `orchestration_step` | Per step output | `{ step, content }` |
| `orchestration_interim` | Every N steps | `{ step, total, insight }` |
| `orchestration_error` | Step failure | `{ step, name, reason }` |

### Configuration

| Env Var | Default | Description |
|---|---|---|
| `MAX_SEQUENTIAL_STEPS` | 6 | Max steps in plan (2-10) |
| `LARGE_DOCUMENT_THRESHOLD` | 50000 | Char threshold for map-reduce trigger |
| `ORCHESTRATION_TIMEOUT_MS` | 120000 | Max wall-clock for full orchestration |
| `STEP_RETRY_COUNT` | 2 | Max attempts per step |
| `PROGRESSIVE_INTERVAL` | 3 | Emit interim synthesis every N steps |

---

## 6. Session Memory (Three-Tier)

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

## 7. SSE Events Emitted During Inference

| Event | Timing | Data |
|---|---|---|
| `session` | Start of stream | `{ sessionId }` |
| `routing` | After routing | Full `RoutingMetadataEvent` (skill, flags, complexity, language, timing, raw LLM data) |
| `orchestration_plan` | After planner (complex mode) | `{ steps: [...], reasoning }` |
| `orchestration_status` | Per step progress | `{ step, total, name, status }` |
| `orchestration_step` | Per step output | `{ step, content }` |
| `orchestration_interim` | Every N steps | `{ step, total, insight }` |
| `orchestration_error` | Step failure | `{ step, name, reason }` |
| `delta` | Per token | `{ type: "text", content: "<token>" }` |
| `metadata` | End of stream | `{ inputTokens, outputTokens }` |
| `verification` | After generate | `{ passed, violations, checks }` |
| `semantic_verdict` | After semantic judge | `{ is_correct, missing_elements[] }` |
| `repair` | After verification/judge failure | `{ text: "<repaired content>" }` |
| `session_status` | On storage failure | `{ sessionId, is_degraded: true }` |
| `done` | AFTER verifier+repair | `{}` |
| `error` | On failure | `{ error, message }` |

**Key timing:** `done` is emitted AFTER the verifier + semantic judge + repair block, so repair results arrive before `done`. This fixes the bug where the frontend received `done`, closed the stream, and repair events arrived too late.

**Batch endpoint** does NOT use SSE — returns plain JSON `{ summary, decisions, actionItems, metadata }`.

---

## 8. Verification & Repair

Two verification layers: deterministic + semantic. Both feed into the same repair pipeline.

### Layer 1: Deterministic (`verifyOutput`)
- Empty output detection
- PII placeholder check disabled intentionally (placeholders in output are correct — masker worked)
- Word count limits from `contract.constraints`
- Required sections from `contract.format.mustInclude` (language-agnostic)
- Forbidden content from `contract.format.mustAvoid`

### Layer 2: Semantic (`semanticJudge`)
- LLM-as-a-judge: calls qwen3-32b (maxTokens=256, temperature=0)
- Runs for high-stakes skills: `compliance_pre_assessment`, `logic_math`, `code`, `risk_analyst`, `data_analysis`
- Returns `{ is_correct: boolean, missing_elements: string[] }`
- Emitted as `event: semantic_verdict` SSE

### Auto-repair (`repairResponse`)
- When either verification layer finds errors, `repairResponse()` calls Bedrock Converse
- Original conversation messages preserved; repair prompt targets only violations
- Repair output → `event: repair` SSE

### Timing
```
generate() or sequentialReasoner → done (emitted by generate path only)
          → verifyOutput() (deterministic)
          → semanticJudge() + repairResponse() ← runs BEFORE done
          → emit done (complex mode only — generate path already emitted it)
          → store, audit, res.end()
```

---

## 9. Document Extraction Pipeline

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

## 10. Two-Stage OCR Pipeline

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

## 11. Gotenberg — Legacy Office Conversion

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

## 12. PII Masker

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
- Applied per-step in sequential reasoning (input + output, fail-closed per step)
- Post-inference PII scan for batch endpoint (defense-in-depth — discards output if PII leaks)

---

## 13. Database Schema

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
| orchestration_meta | JSONB | Sequential reasoning metadata |
| orchestration_group_id | UUID | Groups per-step audit rows |
| orchestration_step_order | INTEGER | 0 = planner, 1-N = steps |
| routing_context | TEXT | Raw classifier routing context snippet |
| routing_intent | TEXT | Raw routing intent from refinement |
| session_context | TEXT | Session classifier context for session row |
| billed_user_id | UUID | [v019] Organizer for cost attribution (bssmom/ghostmeet) |
| billed_group | VARCHAR(255) | [v019] Org group of billed user |
| api_key_used | BOOLEAN | [v019] True if X-API-Key auth was used |

### `feedback_reports`
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| session_id | UUID | |
| user_feedback | TEXT | User's complaint text |
| error_category | VARCHAR(32) | hallucination, missed_context, wrong_tone, formatting_issue, other |
| final_response | TEXT | The LLM output text |
| routing_metadata | JSONB | Enriched: complexity, model, userPrompt, routingContext, flags |
| alignment_summary | TEXT | LLM-generated root cause analysis |
| root_cause_analysis | TEXT | |
| recommendation | TEXT | |
| status | VARCHAR(20) | default 'pending' |
| reviewed_by | VARCHAR(64) | |
| reviewed_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

**Rich feedback:** When user submits feedback, the frontend captures the user prompt and routing context (skill, complexity, flags, verification status) from the status panel. These are stored in `routing_metadata` and fed to the synthesis LLM for root cause analysis.

---

## 14. Configuration (Environment Variables)

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
| `ROUTING_LONG_CONTEXT_THRESHOLD` | 8000 | Char threshold for long-context override |
| `ROUTING_SCORING_TIMEOUT_MS` | 5000 | Complexity scoring timeout |
| `ROUTING_REFINEMENT_TIMEOUT_MS` | 8000 | Prompt refinement timeout |
| `ROUTING_CLASSIFIER_TIMEOUT_MS` | 2000 | Classifier timeout |
| `ROUTING_DEFAULT_FALLBACK_SCORE` | 2 | Default complexity on scoring failure |
| `BATCH_MAX_PROMPT_LENGTH` | 262144 | Max prompt length for batch endpoint (256KB) |
| `GHOSTMEET_API_KEY` | — | API key for M2M batch inference (timingSafeEqual) |
| `BODY_LIMIT` | 10mb | JSON body parser limit (raised for long prompts) |
| `MAX_SEQUENTIAL_STEPS` | 6 | Max steps in sequential reasoning plan |
| `LARGE_DOCUMENT_THRESHOLD` | 50000 | Char threshold for map-reduce trigger |
| `ORCHESTRATION_TIMEOUT_MS` | 120000 | Max wall-clock for orchestration |
| `STEP_RETRY_COUNT` | 2 | Max attempts per step before skipping |
| `PROGRESSIVE_INTERVAL` | 3 | Emit interim synthesis every N steps |
| `EXTRACTION_LOW_CONFIDENCE_THRESHOLD` | 100 | Chars below which confidence = 'low' |
| `EXTRACTION_MAX_JSON_DEPTH` | 20 | Max JSON nesting |
| `EXTRACTION_MAX_HTML_DEPTH` | 100 | Max HTML nesting |
| `EXTRACTION_MAX_CSV_ROWS` | 100000 | Max CSV rows |
| `EXTRACTION_MAX_PPTX_ENTRIES` | 2000 | Max PPTX ZIP entries |
| `GOTENBERG_URL` | — | Gotenberg service URL |
| `GOTENBERG_TIMEOUT_MS` | 30000 | Gotenberg conversion timeout |
| `PPTX_SERVICE_URL` | — | python-pptx microservice URL (internal Cloud Run) |
| `MIN_PASSWORD_LENGTH` | 8 | Minimum password length |

---

## 15. Testing

### Test runner
- Vitest with `globals: true`
- Path alias `@/` → `./src/`

### Test patterns
- **Service tests**: mock database via `vi.mock`, mock Bedrock via `vi.mock('@aws-sdk/client-bedrock-runtime')`
- **Pure function tests**: no mocking needed (context-assembly, content-builder, pii-masker)
- **Route tests**: `vi.mock` for all dependencies

### Test files (26 total)
```
tests/unit/
├── admin.middleware.test.ts
├── app.test.ts
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
├── file-signature-validator.test.ts
├── image-processor.test.ts
├── inference-retry.test.ts
├── inference.routes.test.ts
├── inference.service.test.ts
├── models.routes.test.ts
├── password-reset.middleware.test.ts
├── pii-detection.test.ts
├── pii-masker-nama.test.ts
├── routing-engine.test.ts         # 14 tests (10 invariant rules + baseline)
├── sequential-reasoning.test.ts   # 16 tests (planner, executor, retry, PII, SSE, audit)
├── session-memory.test.ts
└── session.service.test.ts
```

### Routing Engine Invariant Tests
| Test | What it verifies |
|---|---|
| compliance with legal context | Passes through invariant |
| compliance without legal context | Demoted to fallback |
| risk_analyst with risk context | Passes through invariant |
| risk_analyst without risk context | Demoted to fallback |
| data_analysis with data context | Passes through invariant |
| data_analysis without data context | Demoted to fallback |
| code with ``` blocks | Passes through invariant |
| code with function keyword | Passes through invariant |
| code without indicators | Demoted to fallback |
| process_optimization with context | Passes through invariant |
| process_optimization without context | Demoted to fallback |
| credit_analyst with context | Passes through invariant |
| credit_analyst without context | Demoted to fallback |
| meeting_summary with meeting context | Passes through invariant |
| meeting_summary without meeting context | Demoted to fallback |
| cloud_security with cloud context | Passes through invariant |
| cloud_security without cloud context | Demoted to fallback |
| it_specialist with IT context | Passes through invariant |
| it_specialist without IT context | Demoted to fallback |
| non-guarded skills unchanged | business_writing, summarization, fallback unchanged |

---

## 16. Auth Middleware

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

## 17. Batch Inference Endpoint

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

## 18. Important Patterns

- **Unified dispatch**: Single execution path: complexity >= 4 → SequentialReasoner, otherwise → `generate()`. No separate "mode" concept.
- **Post-classification invariant guard**: `validateSkillInvariants()` runs 10 deterministic checks after the LLM classifier. Demotes impossible skill classifications to `fallback`. Zero LLM cost.
- **Head+tail document extraction**: Classifier receives first 2000 + last 1000 chars of document, not just first 800. Better classification signal for long documents.
- **Discovered Roles**: When `skill === 'fallback'` and the refinement model generates a role different from the static "General Purpose Assistant", the role is logged to `data/fallback-roles.ndjson`. The admin dashboard shows a "Discovered Roles" tab with accept/reject/deploy workflow.
- **Rich feedback**: Feedback submission includes the user's original prompt + routing context (skill, flags, verification status) alongside the error category and response text.
- **Language-aware sequential reasoning**: Each step and the final synthesis pass `IMPORTANT: Respond in {language}` as a system prompt.
- **Conditional format enforcement**: System prompt says "CRITICAL FORMAT INSTRUCTION — you MUST follow this" when `output_format` is present, or "respond in plain text" when absent.
- **Indent-aware markdown rendering**: List items track indentation level via a stack, producing proper nested HTML.
- **Done emission timing**: `event: done` emitted AFTER verifier + semantic judge + repair, so repair results arrive before `done`.
- **Fail-closed PII**: If masker throws, inference rejected (500). Never sends unmasked data. Applied per-step in sequential reasoning. Post-inference PII scan for batch endpoint.
- **Graceful degradation**: Routing step failures fall back gracefully. Sequential reasoning falls back to single-shot on planner failure.
- **API key auth**: Constant-time comparison via `timingSafeEqual`. Resolves to `ghostmeet` system user.
- **Passthrough mode (Standard Mode)**: Admin-toggleable global setting that bypasses all routing/refinement/verification. Stored in `app_config` table with in-memory cache. Audit logs record `passthrough=true`. Chat UI shows read-only banner.
- **Session preview from assistant response**: Session sidebar preview uses first assistant message (not user prompt) — better UX for document uploads where prompt is just "jelaskan dokumen ini".
- **Markdown format instruction**: Manual/passthrough modes include explicit `FORMAT_INSTRUCTION` with 7 markdown rules in system prompt — guides model to produce clean markdown output.
- **Emoji heading detection**: Frontend parser treats emoji-prefixed lines (🔹, ✅, etc.) as `<h3>` when the content looks like a title — catches non-standard heading patterns.
- **List-aware heading closing**: When a `###` heading, `---` HR, or emoji heading appears inside a list context, the list is automatically closed before rendering the heading.
- **Surrogate pair support**: Emoji detection regex uses the `u` flag for proper Unicode surrogate pair handling (SMP emojis like 🔹, 🏢).
- **No full content logging**: Audit logs record metadata only.
- **Sanitized errors**: Bedrock errors sanitized — no ARNs, request IDs, or stack traces.
- **Pricing snapshots**: Model pricing captured at inference time for historical accuracy.
- **Billing context**: `billed_user_id`/`billed_group` for per-organizer cost attribution (bssmom/GhostMeet integration).
- **Follow-up refinement**: Turn 2+ uses `FOLLOW_UP_REFINEMENT_PROMPT` — skips role/context fields, emits minimal task+intent JSON.
- **OCR→orchestrator injection**: `effectiveDocText` ensures OCR-extracted content reaches sequential reasoning path.
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
