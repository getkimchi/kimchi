import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * /session — print the current session id.
 *
 * This is the id recorded upstream as telemetry session.id / X-Session-Id
 * (see .kimchi/plans/2026-09-28-unify-session-ids-design.md), so the user can
 * paste it into the console to find their requests.
 */
export default function sessionCommandExtension(pi: ExtensionAPI) {
	pi.registerCommand("session", {
		description: "Show the current session id (used by the console to find your requests)",
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
