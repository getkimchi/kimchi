import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { sideThreadMessages } from "./session.js"

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 })

function sessionWith(messages: Parameters<SessionManager["appendMessage"]>[0][]): AgentSession {
	const sessionManager = SessionManager.inMemory("/project")
	for (const message of messages) sessionManager.appendMessage(message)
	return {
		get messages() {
			return sessionManager.buildSessionContext().messages
		},
		sessionManager,
	} as AgentSession
}

describe("sideThreadMessages", () => {
	it("drops the inherited main-session context", () => {
		const side = { session: sessionWith([user("main"), user("main follow-up"), user("side")]), contextLength: 2 }

		expect(sideThreadMessages(side)).toEqual([user("side")])
	})

	it("keeps the full side thread and later turns after its context compacts", () => {
		const session = sessionWith([user("main"), user("main follow-up"), user("side question")])
		const side = { session, contextLength: 2 }
		const { sessionManager } = session
		const firstThread = sideThreadMessages(side)
		expect(firstThread).toEqual([user("side question")])
		const kept = sessionManager.appendMessage(user("side follow-up"))
		sessionManager.appendCompaction("Condensed conversation", kept, 100_000)
		// AgentSession refreshes its message projection after automatic compaction.
		expect(session.messages).toHaveLength(2)
		expect(sideThreadMessages(side)).toEqual([user("side question"), user("side follow-up")])
		sessionManager.appendMessage(user("after compaction"))
		expect(sideThreadMessages(side).slice(firstThread.length)).toEqual([
			user("side follow-up"),
			user("after compaction"),
		])
	})
})
