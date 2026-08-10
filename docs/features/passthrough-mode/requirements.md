# Passthrough Mode — Requirements

## Overview
Add a "Standard Mode" toggle that bypasses all routing/skill/refinement layers, sending the raw user prompt directly to the model with minimal system prompt. Enables evaluation of base model output without routing engine influence.

## Glossary
- **Routing engine** — classification (24 skills), prompt refinement, complexity scoring, model policy selection
- **Prompt contract** — structured JSON { role, context, task, intent } from refinement
- **Few-shot examples** — skill-specific golden pairs injected before user message
- **Format template** — deterministic output format per skill (requirement_generation → PRD format, meeting_summary → JSON)

## Requirements

### Req 1: Backend passthrough routingState
WHEN user sends request with `routingState: 'passthrough'`
THEN routing engine is skipped entirely (no classify/refine/score)
AND system prompt is minimal: "You are a helpful assistant. Respond in {language}."
AND few-shot examples are NOT injected
AND format templates are NOT applied
AND verification/repair is NOT performed
AND PII masking still runs (security)
AND session management still runs (turn lock, message store)
AND audit logging still runs (with flag `passthrough: true`)
AND execution model = user-selected model, or default (qwen3-32b) if not specified

### Req 2: Admin global toggle
WHEN admin navigates to admin dashboard
THEN they see a "Passthrough Mode" toggle switch
WHEN admin toggles it ON
THEN ALL inference requests from ALL users use passthrough mode (no routing/refinement)
WHEN admin toggles it OFF
THEN normal routing resumes for all users
AND setting persists across server restarts (stored in DB)

### Req 3: Audit passthrough flag
WHEN a passthrough request completes
THEN audit_logs records `passthrough: true` for filtering/reporting

### Req 4: Passthrough indicator for end users
WHEN passthrough mode is globally active
THEN chat UI shows a persistent badge "⚡ Standard Mode" (informational only, not toggleable)
AND routing transparency panel shows minimal info: model + "Passthrough mode"
