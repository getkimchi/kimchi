/**
 * Nemotron family phase-guideline overrides.
 *
 * Sourced from:
 * - docs/phase-guidelines-research.md §3.4 (Nemotron 3 Super FP4)
 * - Nemotron model family overview (build.nvidia.com)
 * - Nemotron technical report (research.nvidia.com)
 *
 * Only guidelines that ADD to or OVERRIDE the defaults are listed here.
 * Lines already covered by default-phase-guidelines.ts have been removed.
 */

// ── Family-level (shared across all Nemotron models) ──────────────────
// Sources: Nemotron model family overview (build.nvidia.com), technical report

/** Reserved: no family-level explore/research/plan overrides identified yet. */
export const NEMOTRON_FAMILY_EXPLORE = ""
export const NEMOTRON_FAMILY_RESEARCH = ""
export const NEMOTRON_FAMILY_PLAN = ""

/** Nemotron family build: leverage the architecture's long context window. */
export const NEMOTRON_FAMILY_BUILD = `During **build** phase (Nemotron family):
- Your long context window is a strength — read each file in full before editing.`

/** Reserved: no family-level review override identified yet. */
export const NEMOTRON_FAMILY_REVIEW = ""
/** Nemotron family orchestration: leverage long-context for subagent results.
 * Sources: §3.4 item 1 (1M context window, near-perfect retrieval) */
export const NEMOTRON_FAMILY_ORCHESTRATION = `When orchestrating (Nemotron family):
- Read subagent results in full — your long context window lets you ingest them completely. Do not skim or skip sections when deciding next steps.`

// ── Nemotron 3 Super FP4 per-model overrides ──────────────────────────
// Sources: in-pool benchmark observations (weakest coder, multi-file unreliability)

/** Reserved: no Nemotron 3 Super-specific orchestration override identified yet. */
export const NEMOTRON_3_SUPER_ORCHESTRATION = ""

/** Nemotron 3 Super build: conservative scope for FP4 quantisation's coding weakness. */
export const NEMOTRON_3_SUPER_BUILD = `During **build** phase (nemotron-3-super-fp4 specific):
- Stay strictly within the spec. Do NOT design, refactor, or expand scope. If the spec is ambiguous, stop and report — do not improvise.
- Touch one file at a time when possible. Avoid multi-file refactors; your reliability drops sharply on those.
- If a fix attempt fails twice, stop and report the error rather than retrying blindly.`
