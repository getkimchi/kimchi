// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/**
 * Default orchestration guidelines appended to the system prompt when a model
 * acts as the orchestrator. Model-specific overrides in builtin-models.ts
 * REPLACE this default (same semantics as phase guidelines).
 *
 * The orchestrator system-prompt template already contains comprehensive
 * delegation rules, token-budget tables, and model-selection guidance.
 * This constant is for cross-cutting orchestration advice that applies
 * regardless of model. Keep it empty until there is a proven universal need.
 */
export const DEFAULT_ORCHESTRATION_GUIDELINES = ""
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
