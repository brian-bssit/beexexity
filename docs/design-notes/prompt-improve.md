Below is a concrete v2 architecture. It keeps your current routing idea, but removes the two biggest sources of failure: freeform prompt rewriting and single-label routing.

## Target architecture

Use four explicit stages:

1. **Intent extraction** from the raw prompt.
2. **Constraint normalization** into a structured contract.
3. **Policy/routing** using the contract, not paraphrased prose.
4. **Output verification** against the contract before returning the answer.

This matches the broader pattern in recent work on decomposition, verification, and refinement: break complex instructions into checkable pieces, verify them with reliable checks, then refine only the unsatisfied parts. [openreview](https://openreview.net/pdf?id=WrTjCHs2tS)

## v2 flow

```text
Raw prompt
  ↓
Normalize input
  ↓
Extract structured intent + constraints
  ↓
Detect ambiguity / missing info
  ↓
Route with multi-label confidence
  ↓
Generate using:
  - original prompt
  - prompt contract
  - task policy
  ↓
Verify output against contract
  ↓
Accept / repair / ask clarification
```

The key change is that the “refined prompt” is no longer the user-facing prompt replacement. It becomes an internal **contract** that the final generator must obey. That reduces drift and makes failures auditable.

## Prompt contract schema

Stop using flowing text like “You are a professional email writer.” Replace it with a schema like this:

```json
{
  "task_type": "generation",
  "primary_skill": "email",
  "secondary_skills": ["summarization"],
  "objective": "Write a follow-up email requesting a meeting",
  "audience": "internal stakeholder",
  "tone": "professional, concise",
  "language": "en",
  "format": {
    "type": "email",
    "must_include": ["subject", "greeting", "body", "closing"],
    "must_avoid": ["markdown code fence"]
  },
  "constraints": [
    "keep under 120 words",
    "do not invent facts",
    "mention deadline if present in user input"
  ],
  "ambiguities": [
    "recipient name missing",
    "meeting purpose unspecified"
  ],
  "clarification_needed": false,
  "confidence": 0.87
}
```

This is better because the model can preserve intent, and your verifier can check each field independently. The research on structured output reliability and constraint-following supports exactly this kind of separation between structure, semantics, and compliance. [openreview](https://openreview.net/pdf?id=rSCV1hTZvF)

## Routing redesign

Your current `extractSkill()` substring match is a weak link. Replace it with one of these:

- **Option A: multi-label classifier output** with explicit enum labels and confidence.
- **Option B: hierarchical routing**, first by task family, then by specialty.
- **Option C: hybrid rules + classifier**, where obvious cases are handled by rules and ambiguous cases go to the model.

For example:

```json
{
  "task_family": "transformation",
  "skills": ["email", "rewrite"],
  "modality": "text",
  "confidence": 0.91
}
```

Do not force every prompt into one skill. A user prompt can be both `email` and `summarization`, or `code` and `explanation`. Single-label routing will keep breaking on mixed-intent prompts.

## Verification layer

This is the part you are missing, and it is the most important. Build a verifier that checks the final output against the contract before returning it.

### Verifier checks
- Schema validity.
- Required sections present.
- Prohibited content absent.
- Tone/length constraints satisfied.
- No unsupported factual additions.
- Task completion aligned to original objective.
- Multi-turn coherence if conversation history matters.

For structured tasks, use deterministic validators first. For semantic checks, use a second pass judge or lightweight verifier. Division of complex instruction into single constraints, then verification and refinement, is exactly the pattern shown in Divide-Verify-Refine. [openreview](https://openreview.net/pdf?id=WrTjCHs2tS)

## Refinement strategy

Your refinement loop should not rewrite the prompt from scratch. It should only fix the violated constraints.

Bad:
- “You are a professional X. Here is the intent in flowing prose...”

Better:
- “Constraint 2 failed: missing deadline mention. Revise only this part.”

Example repair payload:

```json
{
  "violations": [
    {
      "field": "format.must_include",
      "issue": "missing subject line"
    },
    {
      "field": "constraints",
      "issue": "word count exceeded by 34 words"
    }
  ],
  "repair_instruction": "Revise the draft to satisfy only these violations while preserving the rest."
}
```

That is much closer to the verifier-refiner loop used in modern self-correction frameworks. [ar5iv.labs.arxiv](https://ar5iv.labs.arxiv.org/html/2506.05305)

## What to remove

You should strongly consider removing or demoting these parts:

- `parseRefinementJson() → flowing text string`.
- `skill-specific prose prompt as the primary effective prompt`.
- `substring match across ALL_SKILLS`.
- `complexity scoring on the refined prompt`.
- `reasoningSummary` as a source of trust; keep it as telemetry only.

Those features are adding confidence theater, not better output.

## What to keep

Keep these, but tighten them:

- JWT auth.
- PII masking.
- Conversation context window.
- Silent upload detection.
- SSE routing metadata.
- Model selection by modality and context size.

Those are solid infrastructure pieces. The issue is not the transport or auth path; the issue is the prompt semantics layer.

## Evaluation framework

You need a measurable eval suite, not opinions. Build it around four metrics:

| Metric | What it measures | Why it matters |
|---|---|---|
| Intent preservation | Does the output still match the user’s real objective? | Prevents prompt drift. |
| Constraint retention | Are all user constraints kept? | Prevents silent omission. |
| Format compliance | Is the output structurally valid? | Critical for downstream use. |
| Repair rate | How often the verifier had to fix output? | Shows routing/refinement quality. |

Add a fifth metric for **clarification quality**: when the prompt is ambiguous, does the system ask the right question instead of guessing?

## Test set design

Build your benchmark from real prompt classes, not synthetic feel-good examples.

### Required slices
- Simple single-intent prompts.
- Mixed-intent prompts.
- Ambiguous prompts.
- Long-context prompts.
- High-risk prompts.
- Format-constrained prompts.
- Multi-turn follow-up prompts.
- PII-heavy prompts.

### Failure cases to include
- Prompt contains two tasks but one label.
- Prompt is short but high-risk.
- Prompt asks for output in a strict format and with a specific tone.
- Prompt requires missing info that cannot be inferred.
- Prompt tries to inject instructions into the context.

This is consistent with evaluation-driven iteration: define requirements, test with representative and adversarial prompts, diagnose failure mode, then fix and re-test. [arxiv](https://arxiv.org/html/2604.05149v1)

## Practical implementation order

Do this in order, not randomly:

1. Add structured prompt contract output.
2. Add multi-label routing with confidence.
3. Add verifier checks for structure and constraints.
4. Add clarification fallback when ambiguity is high.
5. Add repair loop only for specific violations.
6. Add eval suite and regression tracking.

If you try to “improve prompt quality” before adding verification, you are just polishing a broken pipeline.

## Suggested v2 policy

A simple policy table:

| Condition | Action |
|---|---|
| High confidence, low ambiguity | Route and generate normally. |
| High ambiguity, low confidence | Ask clarification. |
| Format-sensitive task | Use strict contract + deterministic validator. |
| High-risk domain | Add extra verification and lower auto-accept threshold. |
| Output fails verifier | Repair once, then escalate or clarify. |

That gives you a system that behaves like an engineering product, not a prompt demo.