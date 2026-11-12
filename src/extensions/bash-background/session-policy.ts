/**
 * Feature-local session policy for background bash: is a human reachable
 * while the agent works ("user-facing"), or is this run unattended?
 *
 * The policy is resolved ONCE per session, when `bashBackgroundExtension`
 * installs the `BashSessionState`, and stored there so the control tool
 * (wait release) and the completion guard share the same decision.
 *
 * Classification (see docs/bash-commands.md and the nonblocking-bash plan):
 *
 *  - User-facing: the interactive TUI and conversational RPC sessions
 *    whose client opted into background runs — the ACP server installs
 *    `mode: "rpc"` (src/modes/acp/server.ts), and `--mode rpc` is the
 *    embedding channel for frontends with a human driving them. A user
 *    can queue a message at any time, so an explicit
 *    `bash_control(wait: true)` yields to it and a chat turn may settle
 *    while managed commands keep running (completion notifications wake
 *    the agent back up — background_run_start/background_run_end tells the client about it).
 *  - Unattended: `--print` and `--mode json` one-shot/headless runs,
 *    agent workers (`isAgentWorker()`) — including workers spawned by a
 *    user-facing parent: worker status takes precedence over transport
 *    mode — AND ACP clients that did NOT opt into background runs at
 *    initialize: without background_run_start/background_run_end handling those clients cannot
 *    show a stop button for an agent-initiated run, so they keep the
 *    pre-#1616 completion guard (a turn cannot end while managed work
 *    lacks a disposition — the client's existing stop button covers it).
 *
 * Derived only from `ExtensionContext.mode` and the established worker
 * context — never from `hasUI`, TTY detection, permission mode, or argv
 * scans (per the plan's classification rules).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"

/** Whether a session's waits/turns may yield to a human's messages. */
export type BashSessionKind = "user-facing" | "unattended"

/** Inputs for {@link resolveBashSessionKind} (injected for testability). */
export interface BashSessionKindInputs {
	/** Transport mode of the session's extension context. */
	mode: ExtensionContext["mode"]
	/** Whether this agent runs as a worker (async context / env). */
	isWorker: boolean
}

/**
 * Whether this process's client can track agent-initiated runs such that
 * a turn may END while managed commands keep running: it renders run
 * start/end and offers its own stop. Default true — the historical rpc
 * premise (a conversational frontend with a human driving it); hosts add
 * the wiring deliberately. Only consulted for rpc-mode sessions; the TUI
 * never reads it and print/json never reach it.
 */
let backgroundRunsPermitted = true

/** Called once per embedding host (e.g. the ACP server at initialize). */
export function setBackgroundRunsPermitted(permitted: boolean): void {
	backgroundRunsPermitted = permitted
}

/** Whether rpc-mode sessions may end turns while background runs continue (default true). */
export function getBackgroundRunsPermitted(): boolean {
	return backgroundRunsPermitted
}

/** Test hook: restore the historical default between cases. */
export function resetBackgroundRunsPermittedForTest(): void {
	backgroundRunsPermitted = true
}

/** Resolve the session kind for one session, once. */
export function resolveBashSessionKind(inputs: BashSessionKindInputs): BashSessionKind {
	// Workers are unattended even under a user-facing parent: their "user"
	// is the orchestrating agent, not a human waiting on a chat turn.
	if (inputs.isWorker) return "unattended"
	// "tui": interactive terminal — a human is always present.
	if (inputs.mode === "tui") return "user-facing"
	// "rpc": conversational protocol sessions (ACP installs "rpc"; bare
	// `--mode rpc` is the embedding channel for frontends with a human
	// driving them). A turn may END while background commands keep running
	// only when the client permits background runs — rendering run
	// start/end and wiring its own stop. Hosts that never declare the
	// wiring (bare RPC: nothing mutates the flag) keep the historical
	// user-facing contract. Everyone else keeps the completion guard: a
	// turn waits out its background commands and the client's existing
	// stop button covers everything.
	if (inputs.mode === "rpc") return getBackgroundRunsPermitted() ? "user-facing" : "unattended"
	// "print"/"json": one-shot headless output — never user-facing.
	return "unattended"
}

/** Resolve the session kind from a live extension context (session_start). */
export function bashSessionKindFromContext(ctx: ExtensionContext): BashSessionKind {
	return resolveBashSessionKind({ mode: ctx.mode, isWorker: isAgentWorker() })
}
