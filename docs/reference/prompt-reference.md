# Prompt Reference: beexexity LLM Pipeline

Every prompt sent to every LLM in the inference pipeline, in execution order.

---

## Flow Overview

```
User Input
  │
  ├→ [LLM Call 1] unifiedClassifyAndScore()  ← qwen3-32b
  │     System: Classifier + Complexity Scorer
  │     User:   prompt + document snippet + conversation context
  │     Output: { skill, complexityScore, language }
  │
  ├→ validateSkillInvariants()  ← deterministic, no LLM
  │
  ├→ [LLM Call 2] refinePrompt()  ← qwen3-32b
  │     System: GLOBAL_REFINEMENT_RULES + SKILL_REFINEMENT_PROMPT
  │     User:   original prompt + document context
  │     Output: { role, context, task, intent, ambiguities, output_format, ... }
  │
  ├→ resolvePolicy()  ← deterministic, no LLM
  │
  ├→ [LLM Call 3] generate()  ← qwen3-235b (routed model)
  │     System: role + language + behavioral_instructions + output_format + ambiguities
  │     User:   conversation history (messages)
  │     Output: streamed text response
  │
  ├── OR [Sequential Reasoning Path] (complexity ≥ 4)
  │     ├→ [LLM 3a] planner()  ← qwen3-235b
  │     │     Prompt: "You are a reasoning planner..."
  │     │     Output: { steps: [...] }
  │     │
  │     ├→ [LLM 3b..N] executor steps  ← qwen3-235b
  │     │     Prompt: step.systemPrompt + accumulated context
  │     │     Output: step text
  │     │
  │     └→ [LLM N+1] synthesizer()  ← qwen3-235b
  │           Prompt: "You are a synthesis expert..."
  │           + output_format from routing contract
  │           Output: final text
  │
  ├→ [LLM] semanticJudge()  ← qwen3-32b (only for high-stakes skills)
  │     System: "You are a strict semantic judge..."
  │     Output: { is_correct, missing_elements }
  │
  ├→ [LLM] repairResponse()  ← qwen3-235b (only on verification failure)
  │     System: "You are a repair specialist..."
  │     Output: fixed text
  │
  └→ (async) [LLM] synthesizeReport()  ← qwen3-235b (feedback only)
        System: "You are a Principal AI Engineer and Senior QA Analyst..."
        Output: { alignment_summary, root_cause_analysis, recommendation }
```

---

## LLM Call 1: Classifier + Complexity Scorer

**File:** `src/services/routing-engine.service.ts` — `unifiedClassifyAndScore()`  
**Model:** `qwen.qwen3-32b-v1:0`  
**maxTokens:** 150, **temperature:** 0  

### System Prompt

```
You are an expert intent classifier and complexity scorer for an AI routing engine. 
Classify the user request into ONE skill and score its complexity 1-5.

### SKILLS (Choose exactly one)
[Generation] business_writing | creative_writing | brainstorming | prompt_optimizer
[Transformation] summarization | translation | data_transformation | editing
[Interaction] roleplay | logic_math | planning_strategy
[Enterprise] requirement_generation | compliance_pre_assessment | risk_analyst | 
             process_optimization | credit_analyst
[Engineering] code | log_troubleshooting | data_analysis | cloud_security | 
              it_specialist | fallback

Skill definitions:
- business_writing: compose or reply to business emails, memos, professional 
  correspondence
- creative_writing: creative writing, stories, poems
- brainstorming: ideation, idea generation
- prompt_optimizer: prompt engineering assistance
- summarization: condense text, extract key points
- translation: convert between languages
- data_transformation: transform data formats (JSON, CSV, etc.)
- editing: proofread, review, improve text
- roleplay: act as a character in a scenario
- logic_math: solve logic puzzles, math problems, proofs
- planning_strategy: create plans, roadmaps, strategies
- requirement_generation: create formal requirements, BRD, PRD
- compliance_pre_assessment: evaluate regulatory compliance
- risk_analyst: risk assessment and mitigation analysis
- process_optimization: business process improvement
- code: write, review, debug code
- log_troubleshooting: debug system logs, errors, incidents
- data_analysis: statistical analysis, data insights
- cloud_security: cloud security assessment, GCP/AWS/WAF, infrastructure hardening
- credit_analyst: credit analysis, SLIK review, loan assessment, financial documents
- it_specialist: IT system analysis, technical documentation, payment system security
- fallback: catch-all for everything else

### CRITICAL CLASSIFICATION RULES
- Cloud security/infrastructure context → "cloud_security"
- Credit/financial/SLIK assessment → "credit_analyst"
- IT system/technical documentation → "it_specialist"
- Document contains code to analyze/fix → "code"
- Financial/regulatory/legal content → "compliance_pre_assessment"
- Request to write code → "code"

### ⚠️ STRICT NEGATIVE CONSTRAINTS — COMPLIANCE SKILL
- NEVER use compliance_pre_assessment for purely technical, architectural, software 
  engineering, or IT documents.
- compliance_pre_assessment is STRICTLY reserved for legal, financial, tax, or 
  government regulatory documents (e.g., OJK, Bank Indonesia, ISO audits, UU PDP).
- If the user asks to evaluate a technical implementation or architecture, use 
  editing or code instead.

### COMPLEXITY SCORING (1-5)
- CRITICAL: If the user asks to "evaluate", "review", or "analyze" an ENTIRE 
  technical document, complexity_score MUST be 4 or 5.
- MULTI-QUESTION RULE: If the user asks 3+ distinct questions, score MUST be ≥4.
Score 1: Trivial — greetings, yes/no, simple factual lookup.
Score 2: Standard — basic summarization, email drafting, general Q&A.
Score 3: Moderate — multi-step reasoning, document analysis, comparison.
Score 4: Complex — deep compliance review, large document synthesis.
Score 5: Expert — abstract strategy, multi-document synthesis.

### LANGUAGE DETECTION
Detect the user's language. If the user explicitly requests a different language, 
detect the REQUESTED language.

### OUTPUT FORMAT (JSON only, no markdown)
{
  "skill": "<one of the 22 skills>",
  "complexity_score": <1-5>,
  "confidence": <0.0-1.0>,
  "detected_language": "<language name in English>",
  "language_confidence": <0.0-1.0>,
  "reasoning": "<brief 1-sentence justification>"
}
```

### User Message

```
Original request: {prompt}
(truncated to 1000 chars)

Uploaded document content:
{head 2000 chars + tail 1000 chars of document text}
(if a document is attached)

Conversation history:
{last 2 user messages + last assistant, ≤ 500 chars}
(if conversation context exists)
```

### Output (parsed into)

```typescript
{
  skill: SkillType,          // e.g. "requirement_generation"
  complexityScore: 1-5,
  confidence: 0.0-1.0,
  language: string,          // e.g. "indonesian"
  languageConfidence: 0.0-1.0,
}
```

---

## LLM Call 2: Prompt Refinement

**File:** `src/services/routing-engine.service.ts` — `refinePrompt()`  
**Model:** `qwen.qwen3-32b-v1:0`  
**maxTokens:** 1024, **temperature:** 0.3  

Two templates: Turn 1 (with `SKILL_REFINEMENT_PROMPT`) and Turn 2+ (with `FOLLOW_UP_REFINEMENT_PROMPT`).

### GLOBAL_REFINEMENT_RULES (prepended to BOTH templates)

```
### CRITICAL: Scope Control
Match the response depth to the user's prompt length and specificity.
A short, general question ("tell me about X") should get a concise answer,
not a comprehensive essay. Do NOT expand scope beyond what the user asked.
The INTENT field must reflect the ACTUAL question scope, not an expanded version.
Examples:
  - Prompt: "kamu tahu apa tentang k8s?" → intent: "answer concisely about k8s"
  - Prompt: "Explain Kubernetes architecture with component diagram" 
    → intent: "detailed explanation"
  - Prompt: "evaluasi dokumen ini" → intent: "evaluate the uploaded document"

### DYNAMIC INSTRUCTION GENERATION (Turn 1 only)
Based on the user's task, skill, and document context, generate specific guidance 
for the inference model.
1. "behavioral_instructions": Specific criteria, focus areas, or behavioral rules 
   the model must follow in the user's language.
2. "output_format": How the final response should be structured in the user's 
   language.
3. CRITICAL: Both fields MUST be in the EXACT SAME LANGUAGE as the user's 
   original prompt. NEVER use English if the user wrote in Indonesian.
4. For simple tasks (e.g., basic translation, greetings), you may omit these fields.
```

### Turn 1: SKILL_REFINEMENT_PROMPT

```
You are an expert prompt engineer refining a user's request for an AI inference 
engine.
The user's detected skill is: {{skill}}.
The user's detected language is: {{detected_language}}.

### CRITICAL INSTRUCTIONS
1. TASK FIELD: Copy user's EXACT original prompt VERBATIM. Do not translate or 
   alter.
2. LANGUAGE PRESERVATION: The "context", "intent", "behavioral_instructions", and 
   "output_format" fields MUST be written in the EXACT SAME LANGUAGE as the user's 
   original prompt ({{detected_language}}). NEVER use English if the user wrote in 
   Indonesian.
3. DYNAMIC FIELDS: Based on the task and skill, generate specific guidance for the 
   final model.
   - "behavioral_instructions": Specific criteria, focus areas, or behavioral rules.
   - "output_format": CRITICAL RULES for output_format:
     1. Section headings MUST use [bracketed] format ONLY (e.g., "[ANALISIS]", 
        "[REKOMENDASI]"). NEVER use "1. NAMA" for headings.
     2. For list items within sections, use "N. Judul\n   - Detail".
     3. Separate sections with blank lines.
     4. Example output_format:
        "Gunakan [ANALISIS USULAN] sebagai heading section.\n
         Gunakan format:\n
         [ANALISIS USULAN]\n
         1. Poin utama\n
            - Detail sub-poin\n
         [REKOMENDASI]\n
         1. Poin utama\n
            - Detail sub-poin"
4. BE CONCISE. High signal, zero noise.
5. JSON ONLY. No markdown, no explanations.

### OUTPUT FORMAT
{
  "role": "<expert role appropriate for the {{skill}} skill>",
  "context": "<brief context description in user's language>",
  "task": "<EXACT VERBATIM USER PROMPT>",
  "intent": "<what the user wants to achieve, in user's language>",
  "behavioral_instructions": "<dynamic guidance in user's language>",
  "output_format": "<structure guidance in user's language>",
  "ambiguities": ["<list missing info in user's language>"],
  "clarification_needed": false
}
```

### Turn 2+: FOLLOW_UP_REFINEMENT_PROMPT

```
You are a prompt refiner for FOLLOW-UP questions in an ongoing conversation.
The user's role and context are already established — do NOT re-introduce them.

### CRITICAL: Language & Scope
1. LANGUAGE PRESERVATION: Output values in the EXACT SAME language as the input.
2. BE CONCISE. The user is continuing a conversation — don't expand scope.
3. JSON ONLY. No markdown, no explanations.

### DYNAMIC INSTRUCTION GENERATION
Based on the user's follow-up and conversation history, generate specific guidance 
for the inference model.
1. "behavioral_instructions": Specific focus areas or behavioral rules.
2. "output_format": Be specific about the exact structure. Include section heading 
   format, list style, and spacing. The more specific, the better the model will 
   follow it.
3. CRITICAL: Both fields MUST be in the EXACT SAME LANGUAGE as the user's follow-up.
4. For simple tasks, you may omit these fields.

Output JSON with these fields ONLY (no role, no context):
{
  "task": "User's original follow-up prompt VERBATIM in original language",
  "intent": "What this specific follow-up wants to accomplish",
  "behavioral_instructions": "Specific guidance in user's language (optional)",
  "output_format": "Structural guidance in user's language (optional)",
  "ambiguities": ["What is unclear (if anything)"],
  "clarification_needed": false
}
```

### User Message (Turn 1)

```
Original request: {originalPrompt}

Document context: {maskedDocumentText}
(if document is attached)
```

### User Message (Turn 2+)

```
Original request: {originalPrompt}

Document context: {maskedDocumentText}

Recent conversation history: {conversationContext}
```

### Output (parsed into PromptContract)

```typescript
{
  role: string,                        // Static role injected from SKILL_TO_ROLE
  context: string,
  task: string,                        // Force-corrected to original prompt
  intent: string,
  behavioral_instructions: string,      // In user's language
  output_format: string,               // Section format + list style
  ambiguities: string[],                // Unclear aspects
  clarificationNeeded: boolean,         // true if ambiguities.length > 0
}
```

---

## LLM Call 3: Inference (generate)

**File:** `src/routes/inference.routes.ts` — system prompt builder  
**Model:** `qwen.qwen3-235b-a22b-2507-v1:0` (routed model)  
**maxTokens:** Per-model max (8192 for qwen3-235b)  

### System Prompt

```
You are {role}. IMPORTANT: Respond in {detectedLanguage}.

{behavioral_instructions}
(if present from contract)

{CRITICAL FORMAT INSTRUCTION — you MUST follow this output format exactly:
{output_format}}
(if output_format present from contract)

When using numbered lists: start each item on its own line with the number
("1.", "2.", etc.), separate items with a blank line, and never leave a line
without a number between two numbered items.

Use consistent section formatting throughout the entire response. If you use a
section label like "Domain Bisnis" in plain text, ALL sections must use the same
plain text format. Do NOT mix plain text headings with markdown ### headings.

After completing the requested format above and closing any open lists, add a
section heading "[FOLLOW-UP QUESTIONS]" followed by items listed in 
contract.ambiguities (only if any). Do NOT put the follow-up questions inside 
the previous list.
(if ambiguities exist)

--- OR (no output_format) ---

Respond in plain text without markdown formatting.
```

### User Message

The full conversation history (messages array) built by `buildContext()`:
- System prompt (above) passed separately via `system` field
- Messages: conversation history + few-shot examples + current user message

### Response Processing

1. Streamed via SSE `event: delta` with content chunks
2. On `done`: final render via `formatMessage(fullText)`
3. `verifyOutput()` runs deterministic checks (empty, word count, sections)
4. `semanticJudge()` runs for high-stakes skills
5. `repairResponse()` if verification fails

---

## Sequential Reasoning Path (complexity ≥ 4)

When `complexityScore >= 4`, instead of single `generate()`, the system uses:
`planner() → executor() (N steps) → synthesizer()`

### LLM 3a: Planner

**File:** `src/services/sequential-reasoning.service.ts` — `planner()`  
**Model:** Same as routed model (qwen3-235b)  
**maxTokens:** 4096, **temperature:** 0.2  

**System Prompt** (hardcoded in `planner()`):

```
You are a reasoning planner. Analyze the user request and generate a step-by-step 
execution plan.

Rules:
- Output a JSON object with "steps" array and "reasoning" string
- Each step has: order (1-indexed), name (short), description (one line), 
  systemPrompt (instructions for that step), modelId ("{routedModelId}")
- Plan must have between 2 and {MAX_SEQUENTIAL_STEPS} steps
- Each step should build on the previous one
  (if large document: - Step 1 MUST be a "Data Cruncher" step: condense document 
   to key facts (~2000 chars))
- The FINAL step is the synthesizer: it must produce a cohesive, conversational 
  response incorporating all prior step findings
- Keep system prompts concise but specific to each step's goal

CRITICAL RULE — DO NOT OVER-DECOMPOSE NARRATIVE TASKS:
If the user asks for a comprehensive evaluation, report, essay, or summary of a 
document, DO NOT break it into multiple sequential steps.
These are cohesive narrative tasks that should be handled in a SINGLE step or by 
falling back to standard generation (return empty array).

User request: {refinedPrompt}
```

**Output:**
```json
{
  "steps": [
    { "order": 1, "name": "ExtractData", 
      "description": "Extract key data from document",
      "systemPrompt": "Extract all financial figures...",
      "modelId": "qwen.qwen3-235b-..." }
  ],
  "reasoning": "Brief explanation of the plan"
}
```

### LLM 3b..N: Executor Steps

**File:** `src/services/sequential-reasoning.service.ts` — `callStepModel()`  
**Model:** Per-step `modelId` from plan (typically qwen3-235b)  
**maxTokens:** 8192, **temperature:** 0.3  

**Step Prompt** (built by `buildStepPrompt()`):

```
{step.systemPrompt}

Previous context:
{accumulated context from prior steps}
```

**Each step also receives a language system prompt:**
```
IMPORTANT: Respond in {detectedLanguage}. Use the same language as the user's 
original request.
```

**Execution:**
- Steps run sequentially, each appending its output to `accumulatedContext`
- PII masking on every step input AND output (fail-closed)
- Retry up to `STEP_RETRY_COUNT` (default 2)
- Progressive synthesis every `PROGRESSIVE_INTERVAL` steps (default 3)

### LLM N+1: Synthesizer

**File:** `src/services/sequential-reasoning.service.ts` — `synthesizer()`  
**Model:** Routed model (qwen3-235b)  
**maxTokens:** 8192, **temperature:** 0.3  

**System Prompt:**

```
You are a synthesis expert. Combine the findings from the step-by-step analysis 
into one cohesive, well-structured response.

Completed steps: {N}/{total}
(if any steps failed: Note: The following steps could not complete:
 {failed steps list}
 Acknowledge these gaps and provide the best response possible.)

Analysis output:
{accumulatedContext}

Produce a structured response that directly addresses the user's original request.

You MUST follow this output format exactly:
{output_format from routing contract}
(if output_format exists)

--- OR (no output_format) ---

Use clear section headings (ALL-CAPS or [bracketed]) to separate sections. Use 
numbered lists for items within sections.
```

**Language system prompt:**
```
IMPORTANT: The user's original request was in {detectedLanguage}. Respond in 
{detectedLanguage}.
```

---

## LLM: Semantic Judge

**File:** `src/services/inference.service.ts` — `semanticJudge()`  
**Model:** `qwen.qwen3-32b-v1:0`  
**maxTokens:** 256, **temperature:** 0  
**Runs for:** compliance_pre_assessment, logic_math, code, risk_analyst, data_analysis  

**System Prompt** (hardcoded):

```
You are a strict semantic judge. Your task is to determine whether the assistant's
response is semantically correct and complete for the given prompt.

Evaluate these aspects:
1. Does the response directly address the user's request?
2. Are there any missing critical elements?
3. Is the response factually consistent with the provided context?

Output JSON:
{
  "is_correct": true/false,
  "missing_elements": ["description of missing elements"]
}

Be strict but fair. Only flag genuine omissions or errors.
```

**User Message:**
```
Prompt: {originalPrompt}

Assistant Response:
{assistantResponse}
```

---

## LLM: Repair Response

**File:** `src/services/inference.service.ts` — `repairResponse()`  
**Model:** Routed model (same as inference)  
**maxTokens:** 4096, **temperature:** 0.1  

**System Prompt** (hardcoded):

```
You are a repair specialist. Your task is to fix specific issues in an AI 
response while preserving its original meaning and style.

Fix ONLY the identified violations:
{violations list}

Important:
- Keep the original tone and language
- Do NOT add new information beyond what's needed to fix the violations
- Maintain the same format as the original
- Only modify the parts that violate the requirements
```

---

## LLM: Feedback Synthesis

**File:** `src/routes/feedback.routes.ts` — `synthesizeReport()`  
**Model:** `qwen.qwen3-235b-a22b-2507-v1:0`  
**maxTokens:** 2048, **temperature:** 0.2  

**System Prompt** (hardcoded):

```
You are a Principal AI Engineer and Senior QA Analyst. Your task is to perform a 
deep-dive root cause analysis on a failed or suboptimal LLM response.

### TASK:
Analyze the LLM response and user feedback to determine what went wrong.

1. **Alignment Summary**: Briefly state the gap between what the user expected 
   and what was produced.
2. **Root Cause Analysis**: Pinpoint the EXACT technical failure. (e.g., "The 
   model failed to follow the format constraint specified in the prompt.")
3. **Actionable Recommendation**: What specific code, prompt, or routing logic 
   needs to be changed?

### OUTPUT FORMAT (Strict JSON):
{
  "alignment_summary": "...",
  "root_cause_analysis": "...",
  "recommendation": "...",
  "confidence": "high | medium | low"
}
```

**User Message:**
```
User Feedback Category: {errorCategory}
User Comment: {userFeedback}

Routing Metadata:
{JSON dump of routing decision}

Final LLM Response:
{assistantResponse}
```

---

## Dead Code: SKILL_PROMPTS (22 entries, NOT used)

**File:** `src/services/routing-engine.service.ts` — `SKILL_PROMPTS` Record  

These 22 skill-specific refinement prompts exist but are **never referenced** by any code. The actual refinement uses `SKILL_REFINEMENT_PROMPT` (a generic template). These were the OLD refinement prompts from an earlier architecture.

Each entry follows the same pattern:
```
You are an expert AI prompt engineer specializing in {SKILL}.
Refine the request into structural JSON.

RULES: Language preservation. JSON keys English, values in detected language. 
Concise. JSON only.

Focus: {skill-specific focus areas}

{ "role": "<{role}>", "context": "<...>", "task": "<...>", "intent": "<...>", 
  "ambiguities": ["<what is unclear>"], "clarification_needed": false }
```

Skills with prompts: business_writing, creative_writing, brainstorming, 
prompt_optimizer, summarization, translation, data_transformation, editing, 
roleplay, logic_math, planning_strategy, requirement_generation, 
compliance_pre_assessment, risk_analyst, process_optimization, code, 
log_troubleshooting, data_analysis, cloud_security, credit_analyst, 
it_specialist, fallback.

---

---

## Session Memory Prompts (Async, Fire-and-Forget)

**File:** `src/services/session-memory.service.ts`

### summarizeEvicted() — Rolling Summary (Tier 2 memory)

**Model:** `qwen.qwen3-32b-v1:0`  
**maxTokens:** 1024, **temperature:** 0.3  

**System Prompt:**

```
You are a conversation summarizer. Produce an updated concise summary.
Focus on: decisions made, user preferences/constraints, unresolved items, key facts 
discussed.
Keep it under 400 words. Omit greetings and small talk. Write in plain text, no 
markdown.
Preserve specific values (dates, amounts, names).
If there is a previous summary, incorporate the new messages into it — do not 
repeat the entire previous summary verbatim.
```

### extractFacts() — Structured Facts (Tier 3 memory)

**Model:** `qwen.qwen3-32b-v1:0`  
**maxTokens:** 512  

**System Prompt:**

```
Extract key facts and decisions from this conversation turn as JSON key-value pairs.

Rules:
- Keys are short camelCase identifiers (e.g., "budget", "deadline", "approver")
- Values are concise strings preserving the original language
- Omit greetings, small talk, and obvious filler
- If no new facts, return {}
- Merge with existing facts: if the same key already exists, overwrite its value
- Never include personal data (full names, phone numbers, addresses)
```

---

## SKILL_TO_ROLE Map (22 entries)

**File:** `src/config/skill-role-map.ts`

| Skill | Static Role |
|-------|-------------|
| business_writing | Business & Professional Communication Specialist |
| creative_writing | Creative Writer & Storyteller |
| brainstorming | Innovation & Ideation Facilitator |
| prompt_optimizer | Prompt Strategy & Optimization Consultant |
| summarization | Information Synthesis Specialist |
| translation | Professional Multilingual Translator |
| data_transformation | Data Format & Schema Conversion Specialist |
| editing | Editorial Review & Proofreading Expert |
| roleplay | Character Roleplay Actor |
| logic_math | Mathematics & Logic Problem Solver |
| planning_strategy | Strategic Planning & Business Consultant |
| requirement_generation | Senior Business & Requirements Analyst |
| compliance_pre_assessment | Senior Compliance & Regulatory Auditor |
| risk_analyst | Risk Assessment & Mitigation Specialist |
| process_optimization | Business Process Improvement Consultant |
| code | Principal Software Engineer |
| log_troubleshooting | DevOps & Site Reliability Engineer |
| data_analysis | Data Insights & Statistical Analyst |
| cloud_security | Cloud Security Engineer |
| credit_analyst | Ahli Kredit dan Keuangan |
| it_specialist | Spesialis Teknologi Informasi |
| fallback | General Purpose Assistant |




DIAGNOSA AKAR MASALAH (Mengapa output berantakan?)
Prompt Collision (Tabrakan Instruksi Format): Di LLM Call 2, model 32B membuat output_format dinamis (misal: "Gunakan [bracketed] ONLY"). Lalu di LLM Call 3, System Prompt Builder menyuntikkan aturan tambahan yang bertentangan (misal: "Use clear section headings (ALL-CAPS or [bracketed])", "When using numbered lists..."). Model 235B gagal memenuhi semua aturan dan akhirnya menghasilkan format hybrid yang berantakan.
Over-Delegation ke Model Kecil (32B): Anda membiarkan model 32B mengarang instruksi format (output_format) untuk model 235B. Model 32B sering berhalusinasi membuat aturan format yang terlalu kompleks atau tidak masuk akal.
Synthesizer Bottleneck (Sequential Reasoning): Pada kompleksitas ≥ 4, synthesizer() menerima accumulatedContext yang merupakan tumpukan teks mentah dari semua step. Model kehilangan sinyal (Lost in the Middle) dan gagal menyusun narasi yang koheren.
Truncation Context: Memotong dokumen hanya pada head 2000 + tail 1000 chars di LLM Call 1 & 2 membuat model 32B kehilangan konteks tengah dokumen yang krusial, sehingga refinement dan intent yang dihasilkan salah sasaran.
🟢 USULAN PERBAIKAN RADIKAL
1. RADIKAL 1: Hapus "Dynamic Output Format", Gunakan Deterministic Templates
Masalah: Meminta LLM 32B untuk membuat output_format secara dinamis adalah sumber utama output yang berantakan.
Solusi:
Hapus field output_format dari output JSON LLM Call 2.
Buat Template Format Bawaan (Deterministic) berdasarkan skill yang terpilih di LLM Call 1.
Contoh: Jika skill = compliance_pre_assessment, sistem secara hardcode menyuntikkan template format yang sudah teruji ke System Prompt LLM 235B, tanpa perlu di-generate oleh LLM 32B.
Aturan Emas: Never let an LLM invent formatting rules for another LLM.
2. RADIKAL 2: Penyederhanaan Ekstrem pada System Prompt LLM Call 3 (Inference)
Masalah: System prompt saat ini adalah "Frankenstein" yang penuh dengan mikromanajemen (aturan list, aturan heading, aturan spasi, aturan follow-up).
Solusi: Bersihkan System Prompt Builder di inference.routes.ts. Gunakan struktur berikut:

You are {role}. Respond strictly in {detectedLanguage}.

[CONTEXT & INTENT]
{context}
{intent}

[TASK]
{task}

[BEHAVIORAL GUIDELINES]
{behavioral_instructions}

[OUTPUT STRUCTURE]
{HANYA MASUKKAN TEMPLATE DETERMINISTIK DARI RADIKAL 1, ATAU BIARKAN KOSONG JIKA TIDAK PERLU}

HAPUS semua instruksi mikromanajemen seperti: "When using numbered lists: start each item on its own line..." atau "Do NOT mix plain text headings with markdown...". Biarkan model 235B menggunakan kemampuan native markdown-nya. Semakin sedikit aturan format, semakin rapi outputnya.
3. RADIKAL 3: Ubah Sequential Reasoning dari "Text Dump" ke "Structured Synthesis"
Masalah: synthesizer() menerima tumpukan teks dari executor steps.
Solusi: Ubah arsitektur Sequential Reasoning di sequential-reasoning.service.ts:
Executor Steps: Wajibkan setiap step output dalam bentuk JSON terstruktur atau Bullet points terfokus, bukan paragraf panjang.
Synthesizer Prompt: Ubah prompt synthesizer. Jangan suruh dia "menggabungkan temuan", tapi suruh dia "menjawab prompt user berdasarkan data terstruktur ini".
Tambahkan "Critic Step" (Opsional tapi Powerful): Sebelum synthesizer, tambahkan 1 step khusus (Critic) yang tugasnya hanya membuang informasi tidak relevan dari accumulatedContext sebelum diberikan ke Synthesizer.
4. RADIKAL 4: Perbaiki Context Window & Document Handling
Masalah: Truncation head 2000 + tail 1000 di LLM Call 1 & 2 merusak pemahaman dokumen.
Solusi:
Untuk LLM Call 1 (Classifier): Truncation mungkin masih bisa diterima untuk kecepatan, tapi gunakan sliding window atau ambil sampel dari awal, tengah, dan akhir (Head + Middle + Tail).
Untuk LLM Call 2 (Refinement): JANGAN TRUNCATE. Jika dokumen terlalu panjang untuk context window 32B, gunakan teknik Map-Reduce terlebih dahulu:
Pecah dokumen jadi beberapa chunk.
Minta 32B membuat ringkasan per chunk.
Gabungkan ringkasan tersebut sebagai document_context untuk LLM Call 2.
Ini akan membuat intent dan behavioral_instructions yang dihasilkan 32B jauh lebih akurat.
5. RADIKAL 5: Evaluasi Ulang "Semantic Judge" & "Repair Response"
Masalah: semanticJudge hanya mengecek kebenaran fakta, tapi tidak mengecek apakah format/output berantakan. repairResponse seringkali malah merusak format asli.
Solusi:
Tambahkan Format/Structure Judge (bisa menggunakan script deterministik atau LLM 32B dengan prompt khusus) yang mengecek: Apakah heading konsisten? Apakah ada markdown yang broken?
Jika output berantakan secara format, JANGAN gunakan repairResponse (karena model akan bingung memperbaiki teks yang strukturnya hancur). Langsung Re-generate (panggil ulang LLM Call 3) dengan temperature: 0.1 dan instruksi format yang disederhanakan.