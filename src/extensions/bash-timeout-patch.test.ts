/**
 * Regression test for the bash timeout stdio-destroy patch.
 *
 * Problem: when a bash command's timeout fires, `killProcessTree` sends
 * SIGKILL to the process group. But on Linux, commands like `opam install`
 * use `bubblewrap` (bwrap) which calls `setsid()` to create a new process
 * group. These `setsid`'d grandchildren escape the process-group kill,
 * inherit the stdout pipe, and keep writing output — which re-arms
 * `waitForChildProcess`'s grace timer indefinitely, causing `ops.exec()`
 * to never resolve and the tool call to hang forever.
 *
 * Fix (patch item 7 in patches/@earendil-works__pi-coding-agent@0.79.10.patch):
 * destroy the child's stdout/stderr streams 500ms after the timeout kill,
 * forcing `waitForChildProcess` to resolve so the timeout error propagates.
 *
 * This test is Linux-only because `setsid` is required to create a child
 * that escapes the process group. On macOS, backgrounded children remain in
 * the parent's process group and are killed by the group SIGKILL, so the
 * bug cannot be reproduced.
 */
import { execSync } from "node:child_process"
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"

const TIMEOUT_SECONDS = 2
// The patch destroys streams 500ms after the kill, so the tool call should
// resolve within timeout + 1s. We use 5s as a generous upper bound — the
// pre-fix behaviour would hang indefinitely.
const MAX_RETURN_SECONDS = 5

describe.skipIf(process.platform !== "linux")("bash timeout: setsid'd grandchild escaping process group", () => {
	afterEach(() => {
		// Kill any surviving orphaned processes from the test.
		// The marker string in the command makes this reliable.
		try {
			execSync("pkill -f 'bash-timeout-regression-marker' 2>/dev/null || true", { stdio: "ignore" })
		} catch {
			// No survivors
		}
	})

	it("returns after timeout when setsid'd child keeps the stdout pipe open", async () => {
		const ops = createLocalBashOperations()
		const start = Date.now()

		// setsid creates a new process group/session. The child writes to
		// stdout continuously, which would re-arm waitForChildProcess's
		// grace timer indefinitely without the stdio-destroy fix.
		// The loop self-terminates after 10s (200 × 0.05s) so even if
		// cleanup fails, no orphan survives past the test run.
		const command = `setsid bash -c 'for i in $(seq 1 200); do echo "bash-timeout-regression-marker $i"; sleep 0.05; done' & wait`

		let error: Error | undefined
		try {
			await ops.exec(command, "/tmp", {
				onData: () => {},
				timeout: TIMEOUT_SECONDS,
			})
		} catch (err) {
			error = err as Error
		}

		const elapsedSec = (Date.now() - start) / 1000

		// The tool call must return (not hang forever).
		expect(error).toBeDefined()
		expect(error?.message).toContain("timeout")

		// Must return within a reasonable window of the timeout.
		// Without the fix, this never resolves.
		expect(elapsedSec).toBeLessThan(MAX_RETURN_SECONDS)
		expect(elapsedSec).toBeGreaterThanOrEqual(TIMEOUT_SECONDS)
	})

	it("returns after timeout when multiple setsid'd children write to stdout", async () => {
		const ops = createLocalBashOperations()
		const start = Date.now()

		// Multiple parallel setsid children, simulating `make -j4` style
		// parallel compilation where each worker escapes the process group.
		// Each child self-terminates after 10s (200 × 0.05s).
		const command = `for i in $(seq 1 4); do
  setsid bash -c 'for j in $(seq 1 200); do echo "bash-timeout-regression-marker $i $j"; sleep 0.05; done' &
done
wait`

		let error: Error | undefined
		try {
			await ops.exec(command, "/tmp", {
				onData: () => {},
				timeout: TIMEOUT_SECONDS,
			})
		} catch (err) {
			error = err as Error
		}

		const elapsedSec = (Date.now() - start) / 1000

		expect(error).toBeDefined()
		expect(error?.message).toContain("timeout")
		expect(elapsedSec).toBeLessThan(MAX_RETURN_SECONDS)
		expect(elapsedSec).toBeGreaterThanOrEqual(TIMEOUT_SECONDS)
	})

	it("still enforces timeout for normal (non-setsid) commands", async () => {
		const ops = createLocalBashOperations()
		const start = Date.now()

		let error: Error | undefined
		try {
			await ops.exec("sleep 60", "/tmp", {
				onData: () => {},
				timeout: TIMEOUT_SECONDS,
			})
		} catch (err) {
			error = err as Error
		}

		const elapsedSec = (Date.now() - start) / 1000

		expect(error).toBeDefined()
		expect(error?.message).toContain("timeout")
		expect(elapsedSec).toBeLessThan(MAX_RETURN_SECONDS)
		expect(elapsedSec).toBeGreaterThanOrEqual(TIMEOUT_SECONDS)
	})

	it("completes normally when command finishes before timeout", async () => {
		const ops = createLocalBashOperations()

		const result = await ops.exec("echo hello && exit 0", "/tmp", {
			onData: () => {},
			timeout: 10,
		})

		expect(result.exitCode).toBe(0)
	})
})

describe("bash finally-block killProcessTree: backgrounded processes killed on normal completion", () => {
	it("kills a backgrounded process when the shell exits normally", async () => {
		const ops = createLocalBashOperations()

		// Launch a background process that writes its PID to a marker file,
		// then keeps running for 30s. After the bash tool returns (echo
		// completes, shell exits 0), the backgrounded process should be
		// killed by killProcessTree in the finally block.
		const markerFile = `/tmp/bash-finally-kill-marker-${process.pid}`
		const command = `rm -f ${markerFile}; (echo $$ > ${markerFile}; sleep 30) & echo "launched"`

		const result = await ops.exec(command, "/tmp", {
			onData: () => {},
			timeout: 10,
		})

		expect(result.exitCode).toBe(0)

		try {
			// Wait for the marker file to appear (background process started).
			const waitForMarker = async (timeoutMs: number) => {
				const deadline = Date.now() + timeoutMs
				while (Date.now() < deadline) {
					try {
						return execSync(`cat ${markerFile} 2>/dev/null`, { encoding: "utf-8" }).trim()
					} catch {
						// File not written yet
					}
					await new Promise((resolve) => setTimeout(resolve, 100))
				}
				return null
			}

			const pidStr = await waitForMarker(3000)
			expect(pidStr).not.toBeNull()
			const bgPid = Number.parseInt(pidStr ?? "0", 10)
			expect(Number.isFinite(bgPid)).toBe(true)

			// Poll process.kill(pid, 0) until the process disappears.
			// This is deterministic — no fixed sleeps.
			const waitForProcessDeath = async (pid: number, timeoutMs: number) => {
				const deadline = Date.now() + timeoutMs
				while (Date.now() < deadline) {
					try {
						process.kill(pid, 0)
						// Process still alive — wait and retry
						await new Promise((resolve) => setTimeout(resolve, 50))
					} catch {
						// Process is dead — done
						return true
					}
				}
				return false // Timed out — process still alive
			}

			const killed = await waitForProcessDeath(bgPid, 5000)
			expect(killed).toBe(true)
		} finally {
			execSync(`rm -f ${markerFile} 2>/dev/null || true`, { stdio: "ignore" })
		}
	})
})
