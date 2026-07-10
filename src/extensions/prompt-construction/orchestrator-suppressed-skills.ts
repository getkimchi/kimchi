/**
 * Canonical names of skills whose workflows conflict with multi-model Orchestration.
 *
 * These names must match skill file names exactly. If a skill is renamed,
 * update this set and the corresponding regression tests so suppression
 * does not silently break.
 */
export const ORCHESTRATOR_SUPPRESSED_SKILL_NAMES = new Set([
	"subagent-driven-development",
	"dispatching-parallel-agents",
	"executing-plans",
	"verification-before-completion",
])
