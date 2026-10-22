import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isTuiSession } from "../prompt-construction/session-user-loop.js"

/**
 * True when a background agent's completion notification is shown to the
 * user after the turn ended. Only the TUI renders extension-triggered runs:
 * on every other surface (rpc / ACP, json, print), an agent still running
 * when the turn ends never reports back to the user, so backgrounded agents
 * must be joined with `get_subagent_result wait: true` before turn end.
 */
export function backgroundNotificationsReachUser(mode: ExtensionContext["mode"]): boolean {
	return mode === "tui"
}

/**
 * Load-time equivalent, for tool descriptions registered before any
 * `ExtensionContext` exists. Built from the same CLI inputs as
 * `hasUserLoop()`: all sessions in one process share a surface, so the
 * process-level check stays consistent with `ctx.mode`.
 */
export function processBackgroundNotificationsReachUser(): boolean {
	return isTuiSession()
}
