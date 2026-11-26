import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { IS_ACP_MODE } from "../../modes/acp/state.js"

let acpClientOptedIn = false

/** ACP initialize sets this, before any session loads, from the client's sessionMessages and backgroundRuns flags. */
export function setSessionMessagesPermitted(permitted: boolean): void {
	acpClientOptedIn = permitted
}

/**
 * The TUI always takes part. An ACP session takes part only when its client opted in: a received message starts a
 * turn no prompt owns (docs/acp-compat.md rule 1). Under ACP `ctx.mode` reads "rpc", as it does in Pi's native RPC
 * mode, so ACP is told apart with IS_ACP_MODE (rule 10). Print and native RPC runs never take part.
 */
export function takesPart(mode: ExtensionContext["mode"]): boolean {
	return mode === "tui" || (IS_ACP_MODE && acpClientOptedIn)
}

/** An ACP client that did not opt in gets nothing registered, not even the command in its palette. */
export function acpClientLeftOut(): boolean {
	return IS_ACP_MODE && !acpClientOptedIn
}
