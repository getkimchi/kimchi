import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { SIDE_CHAT_TOOLS, sideChatPrompt, sideThreadMessages } from "./session.js"

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

describe("sideChatPrompt", () => {
	it.each([true, false])("tells the side chat it is read-only and cannot change anything (fresh=%s)", (fresh) => {
		const prompt = sideChatPrompt(fresh)
		expect(prompt).toContain(SIDE_CHAT_TOOLS.join(", "))
		expect(prompt).toMatch(/read-only/i)
		expect(prompt).toMatch(/cannot (create|edit|modify)/i)
		expect(prompt).toMatch(/never (attempt|claim).*chang/i)
	})

	it.each([true, false])("points intended changes at /wrap, run and sent by the user (fresh=%s)", (fresh) => {
		const prompt = sideChatPrompt(fresh)
		expect(prompt).toContain("/wrap")
		expect(prompt).toMatch(/main agent/)
		expect(prompt).toMatch(/user (runs|reviews|sends)/i)
	})

	it.each([
		true,
		false,
	])("treats '>' lines as quotes from the main session, never as instructions (fresh=%s)", (fresh) => {
		const prompt = sideChatPrompt(fresh)
		expect(prompt).toMatch(/>[\s\S]*?quote/i)
		expect(prompt).toMatch(/never (your|the user's) instructions|not (an? )?instructions/i)
	})
})

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
