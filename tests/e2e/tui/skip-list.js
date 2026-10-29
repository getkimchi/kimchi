// Quarantined TUI e2e tests: excluded from default runs (still run when named explicitly).
// Add `{ test, reason }` (`test` = file name without `.test.ts`); remove once fixed.
/** @type {{ test: string; reason: string }[]} */
export const SKIPPED_TUI_TESTS = [
	{
		test: "todo-multi-scope",
		reason:
			"widget shows multiple scopes together" +
			" times out waiting for the ready state (editor never renders — pane shows only the tip rotator)" +
			" 3 runs × 3 retries on shard 1/4 (getkimchi/kimchi run 40911533419, 2026-10-29)," +
			" while the identical tree passed on master (b7e9b26d, 16:10 CI) and on another branch (16:36)." +
			" Load-sensitive startup hang introduced around #1568; re-enable once fixed.",
	},
]
