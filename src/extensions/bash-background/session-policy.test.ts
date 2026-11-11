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
import { describe, expect, it } from "vitest"
import { resolveBashSessionKind } from "./session-policy.js"

describe("resolveBashSessionKind — policy matrix", () => {
	it("interactive TUI sessions are user-facing", () => {
		expect(resolveBashSessionKind({ mode: "tui", isWorker: false })).toBe("user-facing")
	})

	it("conversational RPC/ACP sessions are user-facing", () => {
		// The ACP server installs mode "rpc" for its sessions
		// (src/modes/acp/server.ts), and `--mode rpc` is the frontend
		// embedding channel — both have a human driving them.
		expect(resolveBashSessionKind({ mode: "rpc", isWorker: false })).toBe("user-facing")
	})

	it("print one-shot output is unattended", () => {
		expect(resolveBashSessionKind({ mode: "print", isWorker: false })).toBe("unattended")
	})

	it("json protocol output is unattended", () => {
		expect(resolveBashSessionKind({ mode: "json", isWorker: false })).toBe("unattended")
	})

	it("agents workers are unattended, including under a user-facing parent (worker precedence)", () => {
		// A worker spawned by the TUI inherits a "tui"-mode context shape,
		// but the worker context must win: its "user" is the orchestrating
		// agent, not a human waiting on a chat turn.
		expect(resolveBashSessionKind({ mode: "tui", isWorker: true })).toBe("unattended")
		expect(resolveBashSessionKind({ mode: "rpc", isWorker: true })).toBe("unattended")
	})
})
