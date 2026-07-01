/**
 * Kimi family orchestration-guideline overrides.
 *
 * Sourced from:
 * - MoonshotAI/Kimi-K2.5 Issue #24 (infinite tool-call loop)
 * - Kilo-Org/kilocode PR #5722 (tool-calling reliability)
 * - Kimi K2.6 release notes (kimi-k2.org)
 *
 * Only guidelines that ADD to or OVERRIDE the defaults are listed here.
 */

// ── Family-level (shared across all Kimi models) ──────────────────────
// Sources: Kimi K2.6 release notes (kimi-k2.org), in-pool observations
//          (version-assumption staleness across libraries, runtimes, and build tools)

/** Kimi family orchestration: plan-first delegation. */
export const KIMI_FAMILY_ORCHESTRATION = `When orchestrating (Kimi family):
- Plan your full delegation sequence in plain text before spawning the first subagent.
- Keep each subagent prompt focused on a single goal — Kimi models hesitate when a prompt mixes unrelated objectives.`

// ── Kimi K2.5 per-model overrides ─────────────────────────────────────
// Sources: MoonshotAI/Kimi-K2.5#24, Kilo-Org/kilocode#5722, session-01-findings

/** K2.5 orchestration: tool-call reliability and cascade prevention. */
export const KIMI_K25_ORCHESTRATION = `When orchestrating (kimi-k2.5 specific):
- Ensure each \`subagent\` tool call is complete and well-formed — your tool-call reliability is lower than other models. Never emit partial or fragmented tool calls.
- If a subagent fails, do NOT attempt the work yourself — you will waste tokens duplicating effort. Spawn a replacement subagent with a simpler, corrected prompt.`

// ── Kimi K2.6 per-model overrides ─────────────────────────────────────
// Sources: Kimi K2.6 release notes (kimi-k2.org/blog/24-kimi-k2-6-release)

/** K2.6 orchestration: chunk-driven delegation. */
export const KIMI_K26_ORCHESTRATION = `When orchestrating (kimi-k2.6 specific):
- Walk the plan's Chunks list: delegate each chunk as a separate subagent call with a 150k token budget. Do NOT combine multiple chunks into one subagent — smaller calls are cheaper and more reliable.
- Run independent chunks in parallel (up to 3 concurrent subagents).
- Trust your built-in context compressor between delegation steps — do NOT manually summarise subagent results before deciding next steps.`
