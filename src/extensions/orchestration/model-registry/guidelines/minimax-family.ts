/**
 * MiniMax family orchestration-guideline overrides.
 *
 * Sourced from:
 * - MiniMax-AI/MiniMax-M2 Issue #77 (function-calling weaknesses)
 * - MiniMax-AI/MiniMax-M2.5 Issue #3 (list-enumeration omissions)
 * - MiniMax M2 best-practices (platform.minimax.io)
 * - Verdent — "What is MiniMax M2 Coding" (production failure-mode analysis)
 *
 * Only guidelines that ADD to or OVERRIDE the defaults are listed here.
 */

// ── Family-level (shared across all MiniMax M2 models) ────────────────
// Sources: MiniMax-M2#77 (tool-calling), MiniMax-M2.5#3 (list-dropping),
//          platform.minimax.io best-practices (step-limit, state tracking),
//          Verdent failure-mode analysis (scope creep, hallucinated APIs)

/** M2 family orchestration: direct web_search, short prompts, single-goal subagents. */
export const MINIMAX_FAMILY_ORCHESTRATION = `When orchestrating (MiniMax M2 family):
- Call \`web_search\` directly for simple lookups — do NOT delegate to a research subagent. M2 models reflexively over-delegate research, costing 10–20× the tokens.
- Keep subagent prompts short and front-load the critical instruction. M2 drops items from long structured contexts.
- Each subagent prompt should target a single focused goal — do not ask a subagent to do multiple unrelated things.`

// ── MiniMax M2.7 per-model overrides ──────────────────────────────────
// Sources: session-01-findings (Go mutex over-use observed in M2.7 benchmarks)

/** M2.7 orchestration: delegation reinforcement.
 * Sources: benchmark sessions 01-05 (M2.7 does 0 Agent calls for many tasks,
 *          causing 300k-1.5M token overruns). */
export const MINIMAX_M27_ORCHESTRATION = `When orchestrating (minimax-m2.7 specific):
- For simple tasks (single file, straightforward change): you may do the work yourself if the step matches your roles.
- For complex tasks (2+ files or multi-step): delegate ALL steps — build, exploration, and review — to separate agents. Do NOT do any of these yourself for complex tasks, even if they match your roles. Split the work into small chunks (1-2 files each) and delegate each chunk. M2.7 produces 300k-1.5M token overruns when it tries complex work inline.
- After delegating, do NOT re-read the files the subagent created or re-run its tests. Trust the subagent result unless it explicitly reported an error.`
