/**
 * Nemotron family orchestration-guideline overrides.
 *
 * Sourced from:
 * - Nemotron model family overview (build.nvidia.com)
 * - Nemotron technical report (research.nvidia.com)
 *
 * Only guidelines that ADD to or OVERRIDE the defaults are listed here.
 */

// ── Family-level (shared across all Nemotron models) ──────────────────
// Sources: Nemotron model family overview (build.nvidia.com), technical report,
//          in-pool benchmark observations (training-data staleness)

/** Nemotron family orchestration: leverage long-context for subagent results. */
export const NEMOTRON_FAMILY_ORCHESTRATION = `When orchestrating (Nemotron family):
- Read subagent results in full — your long context window lets you ingest them completely. Do not skim or skip sections when deciding next steps.`

// ── Nemotron 3 Ultra FP4 per-model overrides ──────────────────────────
// Sources: in-pool benchmark observations (weakest coder, multi-file unreliability)

/** Reserved: no Nemotron 3 Ultra-specific orchestration override identified yet. */
export const NEMOTRON_3_ULTRA_ORCHESTRATION = ""
