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
	// Track any orphaned processes so we can clean them up after the test.
	const orphanPatterns: string[] = []

	afterEach(() => {
		// Kill any surviving orphaned processes from the test.
		for (const pattern of orphanPatterns) {
			try {
				execSync(`pkill -f "${pattern}"`, { stdio: "ignore" })
			} catch {
				// Already dead or pkill not available
			}
		}
		orphanPatterns.length = 0
	})

	it("returns after timeout when setsid'd child keeps the stdout pipe open", async () => {
		const ops = createLocalBashOperations()
		const start = Date.now()

		// setsid creates a new process group/session. The child writes to
		// stdout continuously, which would re-arm waitForChildProcess's
		// grace timer indefinitely without the stdio-destroy fix.
		const command = `setsid bash -c 'for i in $(seq 1 100000); do echo "compile output $i"; sleep 0.01; done' & wait`
		orphanPatterns.push("compile output")

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
		const command = `for i in $(seq 1 4); do
  setsid bash -c 'for j in $(seq 1 100000); do echo "worker $i: $j"; sleep 0.01; done' &
done
wait`
		orphanPatterns.push("worker")

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
