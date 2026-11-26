// `_kimchi.dev/live_sessions` — the other live Kimchi sessions on this machine, so a client can offer them in its
// @ list with their branches. Session-scoped: the asking session is left out and "same repository" is judged from
// its folder. The server serves it only to clients that opted into session messages.

import { RequestError } from "@agentclientprotocol/sdk/unstable"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { liveSessions } from "../../../extensions/session-messages/index.js"

export async function handleLiveSessions(
	getSession: (sessionId: string) => AgentSession | undefined,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const sessionId = params.sessionId
	const session = typeof sessionId === "string" ? getSession(sessionId) : undefined
	if (!session) throw RequestError.invalidParams(undefined, `unknown sessionId ${String(sessionId)}`)
	return {
		sessions: await liveSessions(session.sessionManager.getSessionId(), session.sessionManager.getCwd()),
	}
}
