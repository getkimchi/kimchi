/**
 * MiniMax family phase-guideline overrides.
 *
 * Sourced from:
 * - docs/phase-guidelines-research.md §3.1 (MiniMax M2.7)
 * - MiniMax-AI/MiniMax-M2 Issue #77 (function-calling weaknesses)
 * - MiniMax-AI/MiniMax-M2.5 Issue #3 (list-enumeration omissions)
 * - MiniMax M2 best-practices (platform.minimax.io)
 * - Verdent — "What is MiniMax M2 Coding" (production failure-mode analysis)
 *
 * Only guidelines that ADD to or OVERRIDE the defaults are listed here.
 * Lines already covered by default-phase-guidelines.ts have been removed.
 */

// ── Family-level (shared across all MiniMax M2 models) ────────────────
// Sources: MiniMax-M2#77 (tool-calling), MiniMax-M2.5#3 (list-dropping),
//          platform.minimax.io best-practices (step-limit, state tracking),
//          Verdent failure-mode analysis (scope creep, hallucinated APIs)

/** Reserved: no family-level explore/research/plan overrides identified yet. */
export const MINIMAX_FAMILY_EXPLORE = ""
export const MINIMAX_FAMILY_RESEARCH = ""
export const MINIMAX_FAMILY_PLAN = ""

/** M2 family orchestration: direct web_search, short prompts, single-goal subagents.
 * Sources: §2.2 Issue 1 (reflexive research delegation), §3.1 item 2 (drops long lists),
 *          §3.1 item 5 (step-limit ~100 tool calls) */
export const MINIMAX_FAMILY_ORCHESTRATION = `When orchestrating (MiniMax M2 family):
- Call \`web_search\` directly for simple lookups — do NOT delegate to a research subagent. M2 models reflexively over-delegate research, costing 10–20× the tokens.
- Keep subagent prompts short and front-load the critical instruction. M2 drops items from long structured contexts.
- Each subagent prompt should target a single focused goal — do not ask a subagent to do multiple unrelated things.`

/** M2 family build: architecture-level traits (outline-then-diff, scope, APIs, step-limit). */
export const MINIMAX_FAMILY_BUILD = `During **build** phase (MiniMax M2 family):
- Outline-then-diff: state the change in 1–3 bullets, then emit the minimal diff. No "clever" refactors, no surprise restructuring.
- STAY IN SCOPE. Do NOT add features, error handling, concurrency primitives, or abstractions the task did not explicitly ask for. M2's known failure mode is over-reaching — resist it.
- Verify library methods exist before calling them — do NOT hallucinate APIs.
- Limit each turn to a single focused goal. M2 has excellent state tracking when goals are limited per turn; it degrades when asked to do everything in parallel.`

/** M2 family review: flag architecture-level failure modes in reviewed code. */
export const MINIMAX_FAMILY_REVIEW = `During **review** phase (MiniMax M2 family):
- Flag scope creep aggressively — added features, unsolicited refactors, or new abstractions that the task did not ask for. This is M2's most common failure mode.
- Flag hallucinated APIs (calls to methods that do not exist on the library version in use).`

// ── MiniMax M2.7 per-model overrides ──────────────────────────────────
// Sources: session-01-findings (Go mutex over-use observed in M2.7 benchmarks)

/** M2.7 orchestration: delegation reinforcement.
 * Sources: benchmark sessions 01-05 (M2.7 does 0 Agent calls for many tasks,
 *          causing 300k-1.5M token overruns). */
export const MINIMAX_M27_ORCHESTRATION = `When orchestrating (minimax-m2.7 specific):
- For simple tasks (single file, straightforward change): you may do the work yourself if the step matches your roles.
- For complex tasks (2+ files or multi-step): delegate ALL steps — build, exploration, and review — to separate agents. Do NOT do any of these yourself for complex tasks, even if they match your roles. Split the work into small chunks (1-2 files each) and delegate each chunk. M2.7 produces 300k-1.5M token overruns when it tries complex work inline.
- After delegating, do NOT re-read the files the subagent created or re-run its tests. Trust the subagent result unless it explicitly reported an error.`

/** M2.7 build: Go-specific concurrency pattern observed in M2.7. */
export const MINIMAX_M27_BUILD = `During **build** phase (minimax-m2.7 specific):
- Do NOT default to mutex-based concurrency in Go (or any pattern not specified). Use exactly the concurrency primitive the task names; if none is named, ask.`

/** M2.7 review: flag Go-specific concurrency issues. */
export const MINIMAX_M27_REVIEW = `During **review** phase (minimax-m2.7 specific):
- Flag inappropriate concurrency choices (e.g. mutex spam in Go where none was requested).`
