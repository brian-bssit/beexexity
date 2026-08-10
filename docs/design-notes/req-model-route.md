# Requirements Document: Model Routing Feature

## Introduction

This document defines the requirements for the Model Routing Feature in the Unified Inference Gateway. The feature adds server-side prompt refinement, complexity scoring, and policy-based automatic routing on top of the already implemented capabilities for authentication, manual model selection, PII masking, Jakarta-region inference routing, audit logging, live session cost display, and multimodal upload support. The routing feature must operate within the existing banking constraints: processing remains confined to AWS Bedrock in ap-southeast-3, PII masking remains mandatory before any model invocation, manual model selection remains available, and multimodal uploads remain subject to model capability constraints. [research.nvidia](https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3-Super-Technical-Report.pdf)

The feature does not remove the current dropdown-based model selection experience. Instead, it changes the default operating behavior so that requests begin in auto mode, while allowing users to activate manual mode implicitly by selecting a specific model from the dropdown. The goal is to improve quality and consistency without violating compliance boundaries or introducing hidden model switching.

## Glossary

- **Routing_Engine**: The server-side component that refines prompts, evaluates complexity, checks modality and policy constraints, and produces the final routing decision.
- **Complexity_Score**: An integer score from 1 to 5 representing the estimated reasoning difficulty of a request.
- **Refined_Prompt**: A cleaned, model-facing reformulation of the original user request and eligible extracted context.
- **Routing_State**: The request-level routing state; allowed values are `auto` and `manual`.
- **Routing_Decision**: The final routing outcome including executed model, routing state, reason code, modality flags, and whether manual override was applied.
- **Modality_Flags**: Derived request attributes indicating text-only, document-text, image, or mixed input.
- **Vision_Model**: A model that accepts image content in addition to text.
- **Reasoning_Summary**: A concise explanation of why a routing decision was made; this is not full chain-of-thought.
- **Capability_Registry**: The existing model-capabilities configuration identifying whether a model supports text only or text and image.

## Requirements

### Requirement 1: Prompt Refinement

**User Story:** As a banking employee, I want the system to refine my raw request into a clearer model-facing prompt, so that downstream model execution is more consistent without requiring me to write perfect prompts.

#### Acceptance Criteria

1. WHEN a user submits a request, THE Routing_Engine SHALL generate a Refined_Prompt before final routing is determined.
2. THE Routing_Engine SHALL incorporate the original user prompt and any already-extracted, already-masked document text into the Refined_Prompt when attachments are present.
3. THE Routing_Engine SHALL NOT include raw unmasked PII in the Refined_Prompt. [perplexity](https://www.perplexity.ai/search/573c5bdb-2cde-448b-bb42-df311c5f03ff)
4. IF prompt refinement fails, THEN THE Gateway SHALL continue using the original masked prompt and record a refinement-failed routing flag.
5. THE Gateway SHALL keep the Refined_Prompt available for debugging, admin review, or optional UI exposure based on policy.

### Requirement 2: Complexity Scoring

**User Story:** As a platform owner, I want each request scored by complexity, so that the gateway can consistently distinguish cheap requests from expensive reasoning tasks.

#### Acceptance Criteria

1. WHEN a request is received, THE Routing_Engine SHALL assign a Complexity_Score from 1 to 5.
2. THE Complexity_Score SHALL be derived from the request text and any extracted document context that is eligible for inference.
3. THE Gateway SHALL interpret the score bands as follows:
   - 1 to 3: direct-answer lane
   - 4: stronger reasoning lane
   - 5: advanced reasoning lane
4. THE Routing_Engine SHALL emit machine-readable routing metadata that includes the score, score band, and confidence indicator.
5. IF scoring fails, THEN THE Gateway SHALL default the score to a configurable fallback value and log the event.

### Requirement 3: Routing State and Model Selection Experience

**User Story:** As a banking employee, I want the gateway to default to automatic routing while still allowing me to explicitly choose a model when needed, so that I get efficient default behavior without losing manual control.

#### Acceptance Criteria

1. THE Gateway SHALL support two routing states only: `auto` and `manual`.
2. THE default selection experience SHALL start in `auto` state for every new request.
3. THE frontend SHALL provide a model selection dropdown containing the list of available models.
4. WHEN the user does not select a specific model from the dropdown, THE Gateway SHALL keep the request in `auto` state and THE Routing_Engine SHALL determine the execution model.
5. WHEN the user selects a specific model from the dropdown, THE Gateway SHALL automatically switch the request to `manual` state.
6. IN `manual` state, THE Gateway SHALL use the user-selected Model_ID as the execution target, subject to existing validation and modality compatibility rules.
7. THE active Routing_State SHALL be included in routing metadata.
8. THE Routing_State SHALL be determined per request and SHALL NOT permanently alter session behavior unless a future requirement explicitly introduces persistent preference storage.

### Requirement 4: Text-Only Routing Policy

**User Story:** As a platform owner, I want text-only requests routed according to reasoning difficulty, so that routine traffic uses cheaper models and harder requests use stronger models.

#### Acceptance Criteria

1. THE list of available models for this routing feature SHALL exclude `deepseek.v3-v1:0`.
2. THE Routing_Engine SHALL consider only the following available models for text routing decisions:
   - `nvidia.nemotron-super-3-120b`
   - `openai.gpt-oss-120b-1:0`
   - `qwen.qwen3-235b-a22b-2507-v1:0`
   - `qwen.qwen3-32b-v1:0`
3. WHEN a request is text-only and Complexity_Score is 1 to 3, THE Routing_Engine SHALL select `qwen.qwen3-32b-v1:0` as the default execution model in `auto` state because it is a low-cost available option suitable for lower-complexity traffic.
4. WHEN a request is text-only and Complexity_Score is 4, THE Routing_Engine SHALL select `nvidia.nemotron-super-3-120b` as the default execution model in `auto` state because it provides a stronger balance of throughput and long-context capability among the remaining available models. [research.nvidia](https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3-Super-Technical-Report.pdf)
5. WHEN a request is text-only and Complexity_Score is 5, THE Routing_Engine SHALL select `qwen.qwen3-235b-a22b-2507-v1:0` as the premium reasoning lane in `auto` state. [artificialanalysis](https://artificialanalysis.ai/models/comparisons/gpt-oss-120b-vs-qwen3-235b-a22b-instruct-2507-reasoning)
6. THE Routing_Engine SHALL NOT route any request to `deepseek.v3-v1:0`.
7. THE Gateway SHALL reject any manual request that specifies `deepseek.v3-v1:0` once this requirement is in effect.
8. THE Gateway SHALL preserve compatibility with the existing manual model-selection behavior for the remaining supported models and SHALL continue to reject unsupported Model_ID values using the existing validation path.

### Requirement 5: Multimodal-Aware Routing

**User Story:** As a banking employee uploading files, I want routing decisions to respect attachment type and model capability, so that requests are not sent to models that cannot process them.

#### Acceptance Criteria

1. WHEN image attachments are present, THE Routing_Engine SHALL consult the existing Capability_Registry before selecting the execution model.
2. IF the request is in `auto` state and image attachments are present, THEN THE Routing_Engine SHALL select only from image-capable models.
3. IF the request is in `manual` state and the selected model is text-only while image attachments are present, THEN THE Gateway SHALL reject the request with a compatibility validation error.
4. WHEN document uploads are present without images, THE Routing_Engine SHALL treat the request as text-augmented after extraction and masking, not as a vision request.
5. THE Routing_Engine SHALL preserve the existing multimodal behavior: extracted document text is included only after masking, and image content is forwarded only to compatible models.
6. THE Routing_Engine SHALL expose Modality_Flags in the routing metadata.

### Requirement 6: Manual Override and User Control

**User Story:** As a banking employee, I want automatic routing to remain visible and overridable through explicit model selection, so that model choice does not become a hidden system decision.

#### Acceptance Criteria

1. THE Gateway SHALL continue to present the existing model dropdown to users unless a future requirement explicitly removes it.
2. IN `auto` state, THE Routing_Engine SHALL determine the execution model according to routing policy.
3. IN `manual` state, THE user-selected valid Model_ID SHALL always be used as the execution target unless rejected by existing modality compatibility or input validation rules.
4. THE Gateway SHALL record whether the final model came from `auto` routing or `manual` user selection in routing metadata.
5. THE Gateway SHALL support role-based policy so that administrators may have broader override rights than standard users if required by future policy.

### Requirement 7: Long-Context Routing

**User Story:** As a platform owner, I want requests with unusually large context or agentic characteristics routed differently, so that the gateway does not under-serve complex workloads.

#### Acceptance Criteria

1. WHEN the request contains unusually large extracted context or is tagged by policy as a long-context workflow, THE Routing_Engine SHALL prefer `nvidia.nemotron-super-3-120b` because it supports up to 1M context and is positioned for high-throughput agentic workloads. [deepinfra](https://deepinfra.com/blog/nvidia-nemotron-3-super-deepinfra)
2. THE threshold for long-context routing SHALL be configurable.
3. THE Routing_Engine SHALL emit a specific reason code when long-context logic affects the model choice.
4. IF long-context preference conflicts with a valid user-selected model in `manual` state, THEN THE Gateway SHALL warn but SHALL still honor the valid manual selection.

### Requirement 8: Routing Transparency

**User Story:** As an auditor or platform operator, I want routing decisions to be explainable at a summary level, so that model choice can be reviewed without exposing chain-of-thought.

#### Acceptance Criteria

1. THE Routing_Engine SHALL generate a concise Reasoning_Summary for each Routing_Decision.
2. THE Reasoning_Summary SHALL describe the factors used, such as complexity band, modality, long-context flag, and routing state.
3. THE Gateway SHALL NOT expose full chain-of-thought in production responses by default. [perplexity](https://www.perplexity.ai/search/479f742c-f294-456c-9f0d-7202673e53c6)
4. UI exposure of routing explanations SHALL be configurable by role and environment.
5. THE Reasoning_Summary SHALL be suitable for audit or operations review.

### Requirement 9: API Contract Extension

**User Story:** As an application developer, I want routing metadata available in the API contract, so that clients can display or inspect routing outcomes safely.

#### Acceptance Criteria

1. THE inference response schema SHALL be extended to support optional fields for `refinedPrompt`, `complexityScore`, `routingState`, `executedModelId`, `routingReasonCode`, `reasoningSummary`, and `manualOverrideApplied`.
2. THE API SHALL preserve backward compatibility for existing clients when routing metadata is disabled.
3. THE API SHALL support returning routing metadata for both JSON and multipart requests.
4. THE Gateway SHALL include attachment-derived modality data in responses when present and allowed by policy.

### Requirement 10: Operational Controls and Fallbacks

**User Story:** As an operator, I want safe fallback behavior when routing components fail, so that the gateway remains available under partial failure.

#### Acceptance Criteria

1. IF the Routing_Engine is unavailable, THEN THE Gateway SHALL fall back to the existing manual model-selection behavior.
2. IF the request is in `auto` state and routing fails before model selection is completed, THEN THE Gateway SHALL fall back to `qwen.qwen3-32b-v1:0` as the default execution model, consistent with the existing default-model behavior.