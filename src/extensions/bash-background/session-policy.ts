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
 * Whether the ACP client of THIS PROCESS opted into background runs at
 * initialize (`clientCapabilities._meta["kimchi.dev"].backgroundRuns`).
 * One CLI process serves exactly one ACP client, so a process-scoped flag
 * is sound; the TUI never sets it (TUI is always user-facing).
 */
let acpBackgroundRunsOptedIn = false

/** Called once from the ACP server's initialize handler with the client opt-in. */
export function setAcpBackgroundRunsOptedIn(optedIn: boolean): void {
	acpBackgroundRunsOptedIn = optedIn
}

/** The ACP client of this process opted into background runs (default false). */
export function isAcpBackgroundRunsOptedIn(): boolean {
	return acpBackgroundRunsOptedIn
}

/** Test hook: restore the no-opt-in default between cases. */
export function resetAcpBackgroundRunsOptedInForTest(): void {
	acpBackgroundRunsOptedIn = false
}

/** Resolve the session kind for one session, once. */
export function resolveBashSessionKind(inputs: BashSessionKindInputs): BashSessionKind {
	// Workers are unattended even under a user-facing parent: their "user"
	// is the orchestrating agent, not a human waiting on a chat turn.
	if (inputs.isWorker) return "unattended"
	// "tui": interactive terminal — a human is always present.
	if (inputs.mode === "tui") return "user-facing"
	// "rpc": conversational protocol sessions (ACP installs "rpc"). Since
	// #1616 such a turn may END while background commands keep running and
	// the agent wakes itself with NO prompt outstanding — only clients that
	// opted into background runs (background_run_start/background_run_end + their own stop
	// wiring) can handle that safely. Everyone else keeps the completion
	// guard — pre-#1616 behavior: a turn waits out its background commands
	// and the client's existing stop button covers everything.
	if (inputs.mode === "rpc") return isAcpBackgroundRunsOptedIn() ? "user-facing" : "unattended"
	// "print"/"json": one-shot headless output.
	return "unattended"
}

/** Resolve the session kind from a live extension context (session_start). */
export function bashSessionKindFromContext(ctx: ExtensionContext): BashSessionKind {
	return resolveBashSessionKind({ mode: ctx.mode, isWorker: isAgentWorker() })
}
