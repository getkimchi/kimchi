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
	resetAcpBackgroundRunsOptedInForTest,
	resolveBashSessionKind,
	setAcpBackgroundRunsOptedIn,
} from "./session-policy.js"

afterEach(() => {
	resetAcpBackgroundRunsOptedInForTest()
})

describe("resolveBashSessionKind — policy matrix", () => {
	it("interactive TUI sessions are user-facing", () => {
		expect(resolveBashSessionKind({ mode: "tui", isWorker: false })).toBe("user-facing")
	})

	it("conversational RPC/ACP sessions are user-facing ONLY when the client opted into background runs", () => {
		// The ACP server installs mode "rpc" for its sessions
		// (src/modes/acp/server.ts), and `--mode rpc` is the frontend
		// embedding channel — both have a human driving them. Since #1616 a
		// turn may END while background commands keep running and the agent
		// wakes itself with no prompt outstanding (background_run_start/background_run_end). Only
		// clients that opted into that at initialize can show a stop button
		// for the wake — so the opt-in IS the classification input.
		setAcpBackgroundRunsOptedIn(true)
		expect(resolveBashSessionKind({ mode: "rpc", isWorker: false })).toBe("user-facing")
	})

	it("an rpc client that did NOT opt into background runs keeps the completion guard", () => {
		// The pre-#1616 guard: without background_run_start/background_run_end handling a client
		// cannot present an agent-initiated run's stop button, so its turn
		// waits out background commands and its existing stop button covers
		// everything — no "ghost runs".
		expect(resolveBashSessionKind({ mode: "rpc", isWorker: false })).toBe("unattended")
	})

	it("TUI sessions stay user-facing regardless of the ACP opt-in flag", () => {
		expect(resolveBashSessionKind({ mode: "tui", isWorker: false })).toBe("user-facing")
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
		// agent, not a human waiting on a chat turn. Even an opted-in ACP
		// client cannot upgrade a worker.
		setAcpBackgroundRunsOptedIn(true)
		expect(resolveBashSessionKind({ mode: "tui", isWorker: true })).toBe("unattended")
		expect(resolveBashSessionKind({ mode: "rpc", isWorker: true })).toBe("unattended")
	})
})
