/**
 * Claude family phase-guideline overrides.
 *
 * Sourced from:
 * - docs/phase-guidelines-research.md §3.5 (Claude Opus 4.6)
 * - Anthropic — "Claude Code: best practices for agentic coding"
 * - Anthropic — prompt-engineering guide
 *
 * Only guidelines that ADD to or OVERRIDE the defaults are listed here.
 * Lines already covered by default-phase-guidelines.ts have been removed.
 */

// ── Family-level (shared across all Claude models) ────────────────────
// Sources: Anthropic "Claude Code: best practices for agentic coding",
//          Anthropic prompt-engineering guide (over-planning, verbosity, structured output)

/** Claude family orchestration: proportional delegation, structured prompts.
 * Sources: §3.5 item 1 (over-planning → over-orchestrating),
 *          §3.5 items 2–3 (verbosity, strong structured output) */
export const CLAUDE_FAMILY_ORCHESTRATION = `When orchestrating (Claude family):
- Match delegation granularity to task complexity. A single-file bug fix does not need an explore → plan → build delegation chain — delegate a single build step.
- Write subagent prompts as structured artefacts (file paths, interfaces, acceptance criteria), not verbose prose. Tight prompts save downstream tokens.`

/** Claude family plan: proportional depth, artefact-led, avoid over-planning. */
export const CLAUDE_FAMILY_PLAN = `During **plan** phase (Claude family):
- Match plan depth to task complexity. A single-file edit needs a 5-line spec, not a treatise.
- Lead with concrete artefacts: file paths, function signatures, interfaces. Prose is supporting material, not the headline.
- Stop planning once interfaces and file paths are unambiguous. Over-planning wastes downstream tokens.`

/** Claude family explore: resist over-exploration, trace deep not wide. */
export const CLAUDE_FAMILY_EXPLORE = `During **explore** phase (Claude family):
- Resist over-exploration. Stop when you have the integration points needed to plan, not when you have read every file.
- Trace one call chain end-to-end rather than sampling many shallowly.`

/** Claude family review: decisive, top-N findings only. */
export const CLAUDE_FAMILY_REVIEW = `During **review** phase (Claude family):
- Be decisive — call out the top 3–5 issues, not every observation.`

// ── Claude Opus 4.6 per-model overrides ───────────────────────────────
// Sources: Anthropic "Claude Code" best practices

export const CLAUDE_OPUS_46_ORCHESTRATION = ""

/** Opus 4.6 plan: version-specific addition to family guidelines. */
export const CLAUDE_OPUS_46_PLAN = `During **plan** phase (claude-opus-4-6 specific):
- Don't relitigate decisions in build.`

export const CLAUDE_OPUS_46_EXPLORE = ""
export const CLAUDE_OPUS_46_REVIEW = ""
