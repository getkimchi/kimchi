// Quarantined TUI e2e tests: excluded from default runs (still run when named explicitly).
// Add `{ test, reason }` (`test` = file name without `.test.ts`); remove once fixed.
/** @type {{ test: string; reason: string }[]} */
export const SKIPPED_TUI_TESTS = [
	{
		test: "ferment-phase-review",
		reason:
			"test.fail for a known focus bug is flaky under parallel full-suite runs; passes in isolation but times out when run with other tests",
	},
	{
		test: "plan-to-ferment-promo",
		reason:
			"test.fail for a known dropdown/buffer bug is flaky under parallel full-suite runs; passes in isolation but fails with assertion errors when run with other tests",
	},
	{
		test: "ask-user-form",
		reason:
			"ferment plan-review dialog timing is flaky under parallel full-suite runs; passes in isolation but tool calls execute before the review dialog appears when run with other tests",
	},
	{
		test: "ferment-progress-overlay",
		reason:
			"overlay rendering timing is flaky under parallel full-suite runs; passes in isolation but times out waiting for human: header when run with other tests",
	},
]
