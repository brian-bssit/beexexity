# Design: PPTX Generation (Template-Based)

## Architecture

```
User (Browser)
  │ POST /api/v1/generate/pptx  { prompt, template? }
  ▼
Express API (Cloud Run, asia-southeast2)
  │
  ├─ 1. Auth (JWT) + Rate Limit
  ├─ 2. LLM call: Bedrock Converse (manual model, non-streaming)
  │     System prompt = JSON schema + slide type guide + examples
  │     User prompt = user's presentation request
  │     → Content JSON (string)
  ├─ 3. Parse & validate Content JSON (Zod schema)
  │     On failure → retry once with error feedback to LLM
  ├─ 4. Call python-pptx service (internal, IAM auth)
  │     POST /generate { template, slides }
  │     → .pptx Buffer
  └─ 5. Return Buffer with PPTX Content-Type headers
```

## Components

### 1. New Route: `src/routes/generation.routes.ts`

```
POST /api/v1/generate/pptx
  Body: { prompt: string, template?: string }
  Middleware: authMiddleware, forcePasswordResetMiddleware
  Returns: .pptx binary
```

### 2. PPTX Generator Service: `src/services/pptx-generator.service.ts`

Two functions:
- `generatePptxContentJson(prompt, modelId)` — calls Bedrock Converse with JSON-schema system prompt, returns parsed ContentJSON
- `callPptxService(contentJson, template)` — HTTP POST to python-pptx service, returns Buffer

### 3. Python PPTX Service: `pptx-service/`

```
pptx-service/
├── main.py              # FastAPI app, single /generate endpoint
├── generator.py         # python-pptx logic: open template, fill placeholders
├── schemas.py           # Pydantic models for input validation
├── requirements.txt     # fastapi, uvicorn, python-pptx, google-cloud-storage
├── Dockerfile           # Python 3.12 slim, multi-stage
└── templates/           # .pptx template files (baked into image for cold start)
    └── corporate.pptx
```

### 4. Content JSON Schema (TypeScript + Zod)

```typescript
interface ContentJson {
  meta: {
    title: string;
    subtitle?: string;
    presenter?: string;
    date?: string;
  };
  slides: Slide[];
}

type Slide =
  | { type: 'cover'; title: string; subtitle?: string; date?: string; presenter?: string }
  | { type: 'content'; title: string; bullets: Bullet[]; notes?: string }
  | { type: 'section_divider'; sectionNumber: string; title: string; subtitle?: string }
  | { type: 'comparison'; title: string; left: { heading: string; points: string[] }; right: { heading: string; points: string[] } }
  | { type: 'chart'; title: string; chartType: 'bar' | 'line' | 'pie'; data: ChartData; insight?: string }
  | { type: 'closing'; title: string; subtitle?: string; contact?: string };

interface Bullet {
  text: string;
  level: number; // 0-2 for indentation
}

interface ChartData {
  categories: string[];
  series: { name: string; values: number[] }[];
}
```

### 5. System Prompt Template

Stored as constant in `pptx-generator.service.ts`. Key sections:
- Role: "You are a presentation content architect. Output ONLY valid JSON."
- Schema: Full Content JSON schema with field descriptions
- Slide type guide: When to use each type, max slides (20), optimal bullets per slide (3-5)
- Design philosophy hints: "Use section dividers between major topics. Start with cover, end with closing slide. Vary slide types — don't use 10 content slides in a row."
- Example: 1 complete 5-slide example (cover → divider → content → comparison → closing)

### 6. Template Design Spec (for human designer)

The template .pptx must follow this naming convention:

| Slide Layout | Shape Names | Notes |
|---|---|---|
| Cover | `ph_title`, `ph_subtitle`, `ph_date`, `ph_presenter` | Full-bleed colored background |
| Content | `ph_title`, `ph_body` | Body is a text frame with 3 pre-styled levels |
| Section Divider | `ph_section_number`, `ph_title`, `ph_subtitle` | Large number + colored accent |
| Comparison (2-col) | `ph_title`, `ph_left_heading`, `ph_left_body`, `ph_right_heading`, `ph_right_body` | Two columns with colored headers |
| Chart | `ph_title`, `ph_chart_area`, `ph_insight` | Chart area is a placeholder box |
| Closing | `ph_title`, `ph_subtitle`, `ph_contact` | Matching cover design, simpler |

## Data Flow

```
User: "Buat deck 10-slide tentang Q3 earnings 2026"
  ↓
LLM system prompt (JSON schema + examples)
  ↓
LLM response:
{
  "meta": { "title": "Q3 Earnings Report", "date": "Q3 2026" },
  "slides": [
    { "type": "cover", "title": "Q3 Earnings Report", "subtitle": "Financial Performance Review", "date": "Q3 2026" },
    { "type": "section_divider", "sectionNumber": "01", "title": "Executive Summary" },
    { "type": "content", "title": "Key Highlights", "bullets": [...] },
    ...
  ]
}
  ↓
Zod validation → valid ContentJson
  ↓
POST python-pptx-service/generate
  body: { "template": "corporate", "slides": [...] }
  ↓
python-pptx:
  1. prs = Presentation("templates/corporate.pptx")
  2. For each slide in slides:
     - Map slide.type → slide_layout_index
     - slide = prs.slides.add_slide(layout)
     - Fill shapes by name (ph_title → slide.shapes["ph_title"].text = ...)
  3. buffer = BytesIO(); prs.save(buffer); return buffer
  ↓
Express: set headers → res.send(buffer)
```

## Error Handling

| Scenario | Behavior |
|---|---|
| LLM returns non-JSON/malformed JSON | Parse attempt with ``` fence strip + trailing comma fix. If still fails → retry 1x with error feedback to LLM. If still fails → 422 |
| Content JSON fails Zod validation | 422 with field-level errors, include in retry prompt |
| python-pptx service unreachable | 503, graceful message |
| python-pptx service timeout (>30s) | 504, suggest fewer slides |
| python-pptx validation error (bad slide type) | 500 with sanitized error |
| Template not found in service | 404, log actual template list |
| Bedrock throttled (429) | Existing retry logic (1s/2s/4s exponential backoff) |
| User prompt too long (>500 chars for this flow) | Use existing context budget check, suggest concise prompt |

## Deployment

### python-pptx service
- Cloud Run, `asia-southeast2`
- 512Mi memory, 1 CPU, 60s timeout
- Min 0, max 5 instances (scale-to-zero — cold start ~2s)
- Build trigger: separate `cloudbuild-pptx.yaml`
- Template .pptx files baked into Docker image (no GCS dependency for MVP)
- Internal ingress + IAM auth

### Template Update Flow
1. Designer edits template in PowerPoint → exports .pptx
2. .pptx committed to `pptx-service/templates/`
3. CI rebuilds + redeploys python-pptx service

(Post-MVP: templates in GCS, hot-reload without deploy)

### Main app changes
- No new dependencies (uses built-in `fetch` for internal call)
- No DB migrations needed (no persistence)
- No new env vars needed (python-pptx URL is internal Cloud Run URL, fixed per environment)
