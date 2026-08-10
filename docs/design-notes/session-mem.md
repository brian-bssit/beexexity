Feature Request: Stateful Session Memory for Multi-Turn Inference
Current condition
The current inference pipeline treats each user turn as a mostly independent request. Even after v1.5 and v1.6, the assistant can lose continuity across turns because the previous inference result is not reliably fed back into the next turn’s context. As a result, a single session does not behave like one continuous conversation, and the model may reprocess turn 2 as if it were unrelated to turn 1.

Problem
This creates a broken user experience for multi-turn tasks. Users expect follow-up prompts to build on earlier outputs, but the system forgets prior decisions, constraints, and generated content unless they are manually repeated. That leads to redundant context, inconsistent answers, and incorrect task continuation, especially when the conversation lasts more than a few turns.

Idea to solve the issue
Introduce a stateful session memory layer that preserves conversation continuity for at least 20 turns. The system should keep recent turns verbatim, store a rolling summary of earlier turns, and persist extracted facts, decisions, and unresolved items as session state. This makes the assistant capable of referencing earlier outputs without requiring the user to restate them.

Proposed solution
Build a layered session-state architecture with four memory tiers:

Raw recent turns for immediate context.

Rolling summary for older conversation history.

Structured session facts for durable decisions, preferences, and entities.

Retrieval memory for selectively recalling older turns when needed.

The system should load this session state before each inference, inject it into the prompt, generate the answer, then update the session state afterward. That update should include the latest assistant output, newly extracted facts, and a refreshed summary when necessary. This is the same layered memory approach recommended for long conversations because full-history injection is brittle and expensive.

Functional scope
Must have
Persist session state by sessionId.

Keep the last 6–8 turns raw.

Preserve a rolling summary for older turns.

Store session facts, open items, and last assistant output.

Rebuild the inference prompt using session state, not only the latest user message.

Support at least 20-turn continuity.

Refresh summary automatically when the prompt budget grows too large.

Should have
Fact extraction from assistant and user messages.

Memory versioning for debugging and replay.

Selective retrieval of older turns by semantic match.

Session cleanup/expiry policy.

Out of scope for the first release
Cross-session long-term personal memory.

Full semantic graph memory.

Agent-to-agent shared memory.

Fine-grained memory ranking or learned memory policies.