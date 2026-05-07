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

export const KIMI_FAMILY_EXPLORE = ""
export const KIMI_FAMILY_RESEARCH = ""
export const KIMI_FAMILY_PLAN = ""

/** Kimi family build: plan-first and chunked goals. */
export const KIMI_FAMILY_BUILD = `During **build** phase (Kimi family):
- Plan-first: outline your intended approach before the first tool call.
- Avoid big mixed-goal turns — Kimi models hesitate on turns with multiple unrelated goals. Split into separate steps.`

export const KIMI_FAMILY_REVIEW = ""

// ── Kimi K2.5 per-model overrides ─────────────────────────────────────
// Sources: MoonshotAI/Kimi-K2.5#24, Kilo-Org/kilocode#5722, session-01-findings

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
