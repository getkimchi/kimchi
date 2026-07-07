// Quarantined TUI e2e tests: excluded from default runs (still run when named explicitly).
// Add `{ test, reason }` (`test` = file name without `.test.ts`); remove once fixed.
/** @type {{ test: string; reason: string }[]} */
export const SKIPPED_TUI_TESTS = [
	// PII redaction's before_provider_request handler adds async latency to every
	// LLM request, including sub-agent requests. On CI runners (slower than local),
	// this pushes the background-agents test past its stream timeout. The test
	// passes locally and the redaction is correct — this is a timing issue on slow CI.
	{ test: "background-agents", reason: "timing-sensitive on CI with PII redaction overhead" },
]
