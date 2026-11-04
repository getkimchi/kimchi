// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
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
	"writing-plans",
	"requesting-code-review",
	"receiving-code-review",
	"test-driven-development",
	"systematic-debugging",
	"finishing-a-development-branch",
])
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
