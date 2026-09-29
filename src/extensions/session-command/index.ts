import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * /session-id — print the current session id.
 *
 * This is the id recorded upstream as telemetry session.id / X-Session-Id
 * (see .kimchi/plans/2026-09-28-unify-session-ids-design.md), so the user can
 * paste it into the CastAI console to find their requests.
 *
 * Named "session-id" rather than "session": the interactive TUI dispatches
 * its built-in /session ("Show session info and stats") in onSubmit BEFORE
 * any extension command, so an extension /session would be dead code in the
 * primary mode and flagged as a conflict at startup.
 */
export default function sessionCommandExtension(pi: ExtensionAPI) {
	pi.registerCommand("session-id", {
		description: "Show the current session id — paste it into the console to find your requests",
		handler: async (_args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId()
			if (ctx.hasUI) {
				ctx.ui.notify(`Session id: ${sessionId}`, "info")
			} else {
				console.log(sessionId)
			}
		},
	})
}
