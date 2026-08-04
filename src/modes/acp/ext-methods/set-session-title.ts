// ACP extension method handler for renaming a session.
//
// The handler validates params, looks up the live session, and
// delegates to pi's AgentSession.setSessionName, which persists a
// session_info entry and emits session_info_changed.

import { RequestError } from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"

/**
 * Handler for the `_kimchi.dev/set_session_title` ACP extension method.
 *
 * Sets the display title of the requested session. This is the ACP equivalent
 * of the TUI `/name <name>` command: it writes a session_info entry to the
 * JSONL and emits a session_info_changed event, which the ACP agent surfaces
 * to the client as a session_info_update notification.
 */
export function handleSetSessionTitle(
	getSession: (sessionId: string) => AgentSession | undefined,
	params: Record<string, unknown>,
): Record<string, unknown> {
	const sessionId = params.sessionId
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams(undefined, "sessionId is required and must be a non-empty string")
	}

	const title = params.title
	if (typeof title !== "string") {
		throw RequestError.invalidParams(undefined, "title is required and must be a string")
	}

	const session = getSession(sessionId)
	if (!session) {
		throw RequestError.invalidParams(undefined, `unknown sessionId ${sessionId}`)
	}

	if (title.length > 256) {
		throw RequestError.invalidParams(
			undefined,
			`title must be no longer than 256 characters (received: ${title.length})`,
		)
	}

	session.setSessionName(title)
	return {}
}
