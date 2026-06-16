/**
 * Quarantined TUI e2e tests.
 *
 * Tests listed here are known-failing (usually a test written before its bug is
 * fixed) and are EXCLUDED from default runs so CI stays green. They remain in the
 * tree and still run when named explicitly, e.g.:
 *
 *   pnpm test:e2e:tui ferment-phase-review
 *
 * To quarantine a test: add `{ test, reason }` below (`test` = file name without
 * `.test.ts`). Once the underlying bug is fixed, delete the entry so it gates CI again.
 */

/** @type {{ test: string; reason: string }[]} */
export const SKIPPED_TUI_TESTS = [
	// {
	// 	test: "ferment-phase-review",
	// 	reason: "Bug: phase-review separator (─────) is selectable/navigable; fix pending.",
	// },
]
