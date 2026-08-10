# Passthrough Mode — Design

## Architecture

```
Admin Dashboard (admin.html)
  │  POST /api/v1/admin/config { passthroughMode: true }
  ▼
Server stores in DB (app_config table)
  │
  ▼
All inference requests check app_config.passthrough_mode
  ├── If true → passthrough path
  │     ├── routeRequest() → skipped, minimal decision
  │     ├── System prompt: "You are a helpful assistant. Respond in {lang}."
  │     ├── NO few-shot injection
  │     ├── NO format template
  │     ├── NO verification/repair
  │     └── SSE streaming same (delta, metadata, done)
  └── If false → normal routing path (unchanged)
```

## Data flow: passthrough vs normal

| Step | Normal Auto | Passthrough |
|---|---|---|
| Check app_config | No | Yes (on every request) |
| `routeRequest()` | Full | Return minimal decision, skip LLM calls |
| `refinedPrompt` | Rewritten by skill prompt | Raw `originalPrompt` |
| System prompt | Role-based + behavioral + format | `"You are a helpful assistant."` |
| Few-shot examples | Injected per skill | None |
| Verification/repair | Emitted | Skipped |
| `routing` SSE | Full metadata | Minimal (model, mode=passthrough, skill=fallback) |

## Data model

### New table: `app_config`
```sql
CREATE TABLE IF NOT EXISTS app_config (
  key   VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL
);
INSERT INTO app_config (key, value) VALUES ('passthrough_mode', 'false')
  ON CONFLICT (key) DO NOTHING;
```

## API surface

### Admin toggle endpoints (new, or add to existing admin routes)
```
GET  /api/v1/admin/config        → { passthroughMode: boolean, ... }
PUT  /api/v1/admin/config        → { passthroughMode: boolean }
```

### Chat UI (index.html) — read-only indicator
```
GET  /api/v1/config/passthrough  → { enabled: boolean }
```

## Files to modify

### 1. `src/types/routing.types.ts`
- Add `'passthrough'` to `routingState` union
- Add `passthrough?: boolean` to `RoutingDecision`

### 2. `src/services/routing-engine.service.ts`
- Add guard at top of `routeRequest()`:
  ```
  if (input.routingState === 'passthrough') → return minimal RoutingDecision
  ```
  Same pattern as `'manual'` guard, but:
  - Always `skill: 'fallback'`
  - No contract
  - Flags include `['passthrough']`

### 3. `src/services/config.service.ts` (NEW)
- `getPassthroughMode(): Promise<boolean>` — reads from app_config
- `setPassthroughMode(value: boolean): Promise<void>` — upserts app_config
- Cached in-memory (Map) for hot path, refresh on write

### 4. `src/routes/admin.routes.ts`
- Add `GET /config` — return all app_config values
- Add `PUT /config` — update passthrough_mode (admin-only)

### 5. `src/routes/inference.routes.ts`
- Read `passthroughMode` from config service early in request lifecycle
- If enabled → set `routingState = 'passthrough'` automatically
- Skip system prompt construction
- Skip few-shot injection
- Skip verification/repair
- Emit routing SSE with `mode: 'passthrough'`

### 6. `src/types/audit.types.ts`
- Add `passthrough?: boolean` to `AuditEntry`

### 7. `src/services/audit.service.ts`
- Add `passthrough` to INSERT params

### 8. `migrations/020_add_passthrough_flag.sql`
```sql
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS passthrough BOOLEAN NOT NULL DEFAULT false;
```

### 9. `public/admin.html`
- Add "Passthrough Mode" toggle card (in Settings tab or new section)
- Toggle calls `PUT /api/v1/admin/config { passthroughMode }`
- Load current state on page load via `GET /api/v1/admin/config`

### 10. `public/index.html`
- On page load, fetch passthrough status from `GET /api/v1/config/passthrough`
- If enabled: show persistent badge "⚡ Standard Mode" (read-only)
- Routing SSE handler: for passthrough mode, show minimal panel

## Error handling

| Scenario | Behavior |
|---|---|
| Passthrough ON + no modelId selected | Use default model (qwen3-32b) |
| config service DB error | Fall back to passthrough OFF (safe default) |
| Admin toggles mid-user-request | Toggle applies to next request, not current |
| Passthrough + Bedrock error | Same error handling as normal |
