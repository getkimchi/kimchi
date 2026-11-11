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
 *  - User-facing: the interactive TUI and conversational RPC sessions —
 *    the ACP server installs `mode: "rpc"` (src/modes/acp/server.ts), and
 *    `--mode rpc` is the embedding channel for frontends with a human
 *    driving them. A user can queue a message at any time, so an explicit
 *    `bash_control(wait: true)` yields to it and a chat turn may settle
 *    while managed commands keep running (completion notifications wake
 *    the agent back up).
 *  - Unattended: `--print` and `--mode json` one-shot/headless runs, and
 *    agent workers (`isAgentWorker()`) — including workers spawned by a
 *    user-facing parent: worker status takes precedence over transport
 *    mode. Unattended runs retain the completion guard: the task cannot
 *    finish while managed work lacks a disposition.
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

/** Resolve the session kind for one session, once. */
export function resolveBashSessionKind(inputs: BashSessionKindInputs): BashSessionKind {
	// Workers are unattended even under a user-facing parent: their "user"
	// is the orchestrating agent, not a human waiting on a chat turn.
	if (inputs.isWorker) return "unattended"
	// "tui": interactive terminal. "rpc": conversational protocol sessions
	// (ACP installs "rpc"). "print"/"json": one-shot headless output.
	return inputs.mode === "tui" || inputs.mode === "rpc" ? "user-facing" : "unattended"
}

/** Resolve the session kind from a live extension context (session_start). */
export function bashSessionKindFromContext(ctx: ExtensionContext): BashSessionKind {
	return resolveBashSessionKind({ mode: ctx.mode, isWorker: isAgentWorker() })
}
