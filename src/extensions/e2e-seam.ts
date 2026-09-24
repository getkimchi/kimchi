/**
 * Test-only E2E seam gate.
 *
 * `KIMCHI_E2E_*` environment variables let TUI e2e rigs stub sandbox/ACP/
 * browser pieces — but those read sites are compiled into the production
 * binary, where a stray var (copied dotfile, shared shell env, CI leak)
 * would fabricate results and silently misroute the user.
 *
 * This gate returns the seam's value ONLY inside a test harness:
 *  - vitest workers (VITEST / VITEST_WORKER_ID), or
 *  - processes under the TUI e2e runner (scripts/run-tui-e2e.js sets
 *    KIMCHI_TEST_HARNESS=1; the smoke harness and the TUI fixture forward
 *    it to spawned kimchi binaries).
 * In any other process the read is dead: undefined is returned.
 */
export function readE2eSeam(name: string): string | undefined {
	const harnessed =
		process.env.VITEST !== undefined ||
		process.env.VITEST_WORKER_ID !== undefined ||
		process.env.KIMCHI_TEST_HARNESS === "1"
	if (!harnessed) return undefined
	return process.env[name]
}
