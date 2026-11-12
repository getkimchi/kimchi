/**
 * Policy matrix for the background-bash session classification
 * (./session-policy.ts): which sessions may yield waits/turns to a human
 * ("user-facing") and which keep the unattended completion guard.
 *
 `bashSessionKindFromContext` is exercised through `resolveBashSessionKind`
 * with the same inputs the live context supplies (mode + worker state), so
 * the matrix below IS the launch-path matrix: TUI sessions, ACP/RPC
 * conversational sessions, print/json one-shot output, and workers —
 * including workers launched by a user-facing parent (worker status takes
 * precedence over transport mode).
 */
import { afterEach, describe, expect, it } from "vitest"
import {
	resetBackgroundRunsPermittedForTest,
	resolveBashSessionKind,
	setBackgroundRunsPermitted,
} from "./session-policy.js"

afterEach(() => {
	resetBackgroundRunsPermittedForTest()
})

describe("resolveBashSessionKind — policy matrix", () => {
	it("interactive TUI sessions are user-facing", () => {
		expect(resolveBashSessionKind({ mode: "tui", isWorker: false })).toBe("user-facing")
	})

	it("rpc sessions are user-facing once the host opted into background runs", () => {
		// Native `--mode rpc` gets the lever from cli.ts at launch; ACP
		// gets it from the backgroundRuns capability at initialize. Only
		// an explicit enable turns rpc-mode turns into ones that may END
		// while background commands keep running.
		setBackgroundRunsPermitted(true)
		expect(resolveBashSessionKind({ mode: "rpc", isWorker: false })).toBe("user-facing")
	})

	it("rpc sessions stay on the completion guard until an explicit enable (the default)", () => {
		// A client that cannot render background_run_start/
		// background_run_end or stop an agent-initiated run must not see
		// turns END mid-run: the completion guard makes its turn wait out
		// background commands, and its existing stop button covers
		// everything — no ghost runs.
		expect(resolveBashSessionKind({ mode: "rpc", isWorker: false })).toBe("unattended")
	})

	it("TUI sessions stay user-facing regardless of the permission flag", () => {
		setBackgroundRunsPermitted(false)
		expect(resolveBashSessionKind({ mode: "tui", isWorker: false })).toBe("user-facing")
	})

	it("print one-shot output is unattended under either flag state", () => {
		setBackgroundRunsPermitted(true)
		expect(resolveBashSessionKind({ mode: "print", isWorker: false })).toBe("unattended")
		setBackgroundRunsPermitted(false)
		expect(resolveBashSessionKind({ mode: "print", isWorker: false })).toBe("unattended")
	})

	it("json protocol output is unattended under either flag state", () => {
		setBackgroundRunsPermitted(true)
		expect(resolveBashSessionKind({ mode: "json", isWorker: false })).toBe("unattended")
		setBackgroundRunsPermitted(false)
		expect(resolveBashSessionKind({ mode: "json", isWorker: false })).toBe("unattended")
	})

	it("agents workers are unattended, including under a user-facing parent (worker precedence)", () => {
		// A worker spawned by the TUI inherits a "tui"-mode context shape,
		// but the worker context must win: its "user" is the orchestrating
		// agent, not a human waiting on a chat turn. Even an opted-in ACP
		// client cannot upgrade a worker.
		setBackgroundRunsPermitted(true)
		expect(resolveBashSessionKind({ mode: "tui", isWorker: true })).toBe("unattended")
		expect(resolveBashSessionKind({ mode: "rpc", isWorker: true })).toBe("unattended")
	})
})
