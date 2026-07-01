/**
 * Claude family orchestration-guideline overrides.
 *
 * Sourced from:
 * - Anthropic — "Claude Code: best practices for agentic coding"
 * - Anthropic — prompt-engineering guide
 *
 * Only guidelines that ADD to or OVERRIDE the defaults are listed here.
 */

// ── Family-level (shared across all Claude models) ────────────────────
// Sources: Anthropic "Claude Code: best practices for agentic coding",
//          Anthropic prompt-engineering guide (over-planning, verbosity, structured output)

/** Claude family orchestration: proportional delegation, structured prompts. */
export const CLAUDE_FAMILY_ORCHESTRATION = `When orchestrating (Claude family):
- Match delegation granularity to task complexity. A single-file bug fix does not need an explore → plan → build delegation chain — delegate a single build step.
- Write subagent prompts as structured artefacts (file paths, interfaces, acceptance criteria), not verbose prose. Tight prompts save downstream tokens.`

// ── Claude Opus 4.6 per-model overrides ───────────────────────────────
// Sources: Anthropic "Claude Code" best practices

export const CLAUDE_OPUS_46_ORCHESTRATION = ""
