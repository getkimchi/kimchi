/**
 * Kimi family phase-guideline overrides.
 *
 * Sourced from:
 * - docs/phase-guidelines-research.md §3.2 (Kimi K2.5)
 * - docs/phase-guidelines-research.md §3.3 (Kimi K2.6)
 * - MoonshotAI/Kimi-K2.5 Issue #24 (infinite tool-call loop)
 * - Kilo-Org/kilocode PR #5722 (tool-calling reliability)
 * - Kimi K2.6 release notes (kimi-k2.org)
 *
 * Only guidelines that ADD to or OVERRIDE the defaults are listed here.
 * Lines already covered by default-phase-guidelines.ts have been removed.
 */

// ── Family-level (shared across all Kimi models) ──────────────────────
// Sources: §3.2 item 3 (mixed-goal hesitation), §3.2 item 4 (plan-first groove)

/** Reserved: no family-level explore/research/plan overrides identified yet. */
export const KIMI_FAMILY_EXPLORE = ""
export const KIMI_FAMILY_RESEARCH = ""
export const KIMI_FAMILY_PLAN = ""

/** Kimi family build: plan-first and chunked goals. */
export const KIMI_FAMILY_BUILD = `During **build** phase (Kimi family):
- Plan-first: outline your intended approach before the first tool call.
- Avoid big mixed-goal turns — Kimi models hesitate on turns with multiple unrelated goals. Split into separate steps.`

/** Reserved: no family-level review override identified yet. */
export const KIMI_FAMILY_REVIEW = ""

/** Kimi family orchestration: plan-first delegation.
 * Sources: §3.2 item 4 (plan-first groove), §3.2 item 3 (mixed-goal hesitation) */
export const KIMI_FAMILY_ORCHESTRATION = `When orchestrating (Kimi family):
- Plan your full delegation sequence in plain text before spawning the first subagent.
- Keep each subagent prompt focused on a single goal — Kimi models hesitate when a prompt mixes unrelated objectives.`

// ── Kimi K2.5 per-model overrides ─────────────────────────────────────
// Sources: MoonshotAI/Kimi-K2.5#24, Kilo-Org/kilocode#5722, session-01-findings

/** K2.5 orchestration: tool-call reliability and cascade prevention.
 * Sources: §2.1 (210k wasted on cascade), §3.2 items 1–2 (tool-call bugs) */
export const KIMI_K25_ORCHESTRATION = `When orchestrating (kimi-k2.5 specific):
- Ensure each \`subagent\` tool call is complete and well-formed — your tool-call reliability is lower than other models. Never emit partial or fragmented tool calls.
- If a subagent fails, do NOT attempt the work yourself — you will waste tokens duplicating effort. Spawn a replacement subagent with a simpler, corrected prompt.`

/** K2.5 build: tool-call reliability fixes (K2.5-specific bugs). */
export const KIMI_K25_BUILD = `During **build** phase (kimi-k2.5 specific):
- After every tool result, ALWAYS produce text — either the next tool call with explicit reasoning, or a final summary. Never re-issue the same tool call after a successful result.
- Emit complete, well-formed tool calls only. Never output partial fragments, raw JSON snippets, or "(m"-style stubs as if they were tool calls.`

/** K2.5 explore: chunk inputs and plan reads upfront. */
export const KIMI_K25_EXPLORE = `During **explore** phase (kimi-k2.5 specific):
- Plan-first: state in 3–5 bullets what you intend to read and why, then batch the reads in a single turn.
- Chunk and label long inputs — do NOT pour an entire codebase into one mental pass; group by module.`

// ── Kimi K2.6 per-model overrides ─────────────────────────────────────
// Sources: Kimi K2.6 release notes (kimi-k2.org/blog/24-kimi-k2-6-release)

/** K2.6 orchestration: queue-based swarm delegation.
 * Sources: §3.3 item 1 (agent-swarm primitives), §3.3 item 2 (context compressor) */
export const KIMI_K26_ORCHESTRATION = `When orchestrating (kimi-k2.6 specific):
- You are tuned for agent-swarm orchestration. Decompose tasks into a queue of independent subagent calls and run independent ones in parallel.
- Trust your built-in context compressor between delegation steps — do NOT manually summarise subagent results before deciding next steps.`

/** K2.6 plan: queue-based decomposition for long-horizon orchestration. */
export const KIMI_K26_PLAN = `During **plan** phase (kimi-k2.6 specific):
- You are tuned for long-horizon orchestration: open with a numbered 3–7 step plan before any tool call.
- Decompose ambitious tasks into a queue of independent sub-tasks the build phase can pull from — K2.6 plans best when given a queue, not a single monolithic instruction.
- Include per-step acceptance criteria in the spec.
- Mark each step as "do here" vs. "delegate" so build can route work without re-planning.`

/** K2.6 explore: leverage long context and built-in compressor. */
export const KIMI_K26_EXPLORE = `During **explore** phase (kimi-k2.6 specific):
- Use your long-context strength: prefer reading 3–5 files in full over many partial reads.
- Trust the built-in context compressor — do NOT manually summarise mid-exploration.`
