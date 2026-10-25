import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { lastAssistantText, sideThreadMessages } from "./session.js"

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 })
const assistant = (...text: string[]) => ({
	role: "assistant" as const,
	content: text.map((part) => ({ type: "text" as const, text: part })),
	timestamp: 0,
})

function sessionWith(messages: unknown[]): AgentSession {
	return { messages } as AgentSession
}

describe("lastAssistantText", () => {
	it("returns the latest assistant reply's text", () => {
		const session = sessionWith([assistant("old"), user("q"), assistant(" first", "second "), user("follow-up")])

		expect(lastAssistantText(session)).toBe("first\nsecond")
	})

	it("is empty when the assistant has not replied", () => {
		expect(lastAssistantText(sessionWith([user("q")]))).toBe("")
	})
})

describe("sideThreadMessages", () => {
	it("drops the inherited main-session context", () => {
		const side = { session: sessionWith([user("main"), assistant("main reply"), user("side")]), contextLength: 2 }

		expect(sideThreadMessages(side)).toEqual([user("side")])
	})
})
