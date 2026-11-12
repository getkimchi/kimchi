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
 * Whether this process's embedding host permits background runs: rpc-mode
 * turns may END while managed commands keep running, with run start/end
 * surfaced to a client that can stop them itself. Default false — the
 * lever is opt-in until someone declares the intent. Two explicit
 * writes: cli.ts sets it true for native `--mode rpc` (background runs
 * are standard on that protocol: every effect is a native event, and
 * the rpc abort command stops the wake turn), and the ACP server maps
 * its `backgroundRuns` client capability onto the lever at initialize
 * — false for clients without support. Only consulted for rpc-mode
 * sessions; the TUI never reads it and print/json never reach it.
 */
let backgroundRunsPermitted = false

/** Called once per embedding host (cli.ts for native rpc mode, the ACP server at initialize). */
export function setBackgroundRunsPermitted(permitted: boolean): void {
	backgroundRunsPermitted = permitted
}

/** Whether rpc-mode sessions may end turns while background runs continue (default false). */
export function getBackgroundRunsPermitted(): boolean {
	return backgroundRunsPermitted
}

/** Test hook: restore the default between cases. */
export function resetBackgroundRunsPermittedForTest(): void {
	backgroundRunsPermitted = false
}

/** Resolve the session kind for one session, once. */
export function resolveBashSessionKind(inputs: BashSessionKindInputs): BashSessionKind {
	// Workers are unattended even under a user-facing parent: their "user"
	// is the orchestrating agent, not a human waiting on a chat turn.
	if (inputs.isWorker) return "unattended"
	// "tui": interactive terminal — a human is always present.
	if (inputs.mode === "tui") return "user-facing"
	// "rpc": conversational protocol sessions (ACP installs "rpc"; bare
	// `--mode rpc` is the embedding channel for host integrations). A
	// turn may END while background commands keep running only when the
	// lever is on — cli.ts switches it on for native rpc mode, and the
	// ACP server follows its client's backgroundRuns capability. Anything
	// else on this channel (a host that never declared support) keeps the
	// completion guard: a turn waits out its background commands and the
	// client's existing stop button covers everything.
	if (inputs.mode === "rpc") return getBackgroundRunsPermitted() ? "user-facing" : "unattended"
	// "print"/"json": one-shot headless output — never user-facing.
	return "unattended"
}

/** Resolve the session kind from a live extension context (session_start). */
export function bashSessionKindFromContext(ctx: ExtensionContext): BashSessionKind {
	return resolveBashSessionKind({ mode: ctx.mode, isWorker: isAgentWorker() })
}
