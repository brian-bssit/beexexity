# Tasks: PPTX Generation

## Wave 1: Python PPTX Service

- [ ] **Task 1.1** — Scaffold Python project (`pptx-service/`) [Req 3]
  - `main.py`: FastAPI app with health check + `POST /generate`
  - `requirements.txt`: fastapi, uvicorn, python-pptx
  - `Dockerfile`: Python 3.12-slim, uvicorn runner
  - `cloudbuild-pptx.yaml`: Cloud Run deploy config
- [ ] **Task 1.2** — Implement `generator.py` — slide type → placeholder fill logic [Req 2, Req 3]
  - Map 6 slide types to layout indices
  - Fill shapes by name (`ph_title`, `ph_body`, etc.)
  - Handle bullets with indentation levels
  - Handle chart data (python-pptx chart API)
  - Return BytesIO buffer
- [ ] **Task 1.3** — Create initial "corporate" template [Req 2]
  - Design in PowerPoint: 6 slide layouts with proper shape names
  - Navy+gold theme, Montserrat headings, Inter body
  - Geometric decorations (corner accents, colored bars)
  - Export to `pptx-service/templates/corporate.pptx`
- [ ] **Task 1.4** — Input validation with Pydantic schemas [Req 3]
  - `schemas.py`: ContentJson model matching all slide types
  - Field validation: required fields, enum values, string lengths
  - Return 400 with field-level errors on invalid input

**Checkpoint 1** — Deploy python-pptx service, verify `POST /generate` with sample JSON returns valid .pptx

## Wave 2: Main App Integration

- [ ] **Task 2.1** — Content JSON types + Zod schema [Req 4]
  - `src/types/pptx.types.ts`: TypeScript interfaces matching Python Pydantic schemas
  - Zod validation schema in `pptx-generator.service.ts`
- [ ] **Task 2.2** — System prompt constant [Req 4]
  - `SYSTEM_PROMPT_PPTX` with: role definition, JSON schema, slide type guide, design tips, 1 full example
  - Stored in `src/services/pptx-generator.service.ts`
- [ ] **Task 2.3** — `pptx-generator.service.ts` [Req 1, Req 3]
  - `generateContentJson(prompt, modelId)`: Call Bedrock Converse (non-streaming), parse JSON response, validate with Zod, retry 1x on failure
  - `callPptxService(contentJson, template)`: HTTP POST to python-pptx internal URL, return Buffer
  - JSON parse helper: strip ``` fences, fix trailing commas
- [ ] **Task 2.4** — Route: `POST /api/v1/generate/pptx` [Req 1]
  - `src/routes/generation.routes.ts`: auth middleware, validate body, call service, return .pptx
  - Mount in `src/app.ts`
  - Rate limit: 5/min (separate from inference rate limit)
- [ ] **Task 2.5** — Config + env vars [Req 3]
  - `PPTX_SERVICE_URL` env var (internal Cloud Run URL)
  - Default template in `src/config/index.ts`
  - IAM auth for internal service-to-service call (GCP metadata server token)

**Checkpoint 2** — End-to-end test: `curl POST /api/v1/generate/pptx -d '{"prompt":"Buat 5-slide pitch deck startup fintech"}'` → valid .pptx file

## Wave 3: Polish & Deploy

- [ ] **Task 3.1** — Error UX in frontend [Req 1]
  - Handle non-file responses (errors) gracefully
  - Show progress state during generation (spinner + "Generating presentation...")
  - Download trigger on success
- [ ] **Task 3.2** — Template refinement [Req 2]
  - Test with real-world prompts, iterate template design
  - Verify all 6 slide types render correctly
  - Font embedding check (template fonts available in container)
- [ ] **Task 3.3** — Production deploy [Req 3]
  - Deploy python-pptx service first (get internal URL)
  - Update main app env vars
  - Deploy main app with new route
  - Smoke test in production

**Checkpoint 3** — Production ready, manual test with real presentation prompts
