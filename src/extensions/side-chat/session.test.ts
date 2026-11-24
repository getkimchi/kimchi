import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import {
	PENDING_TOOL_RESULT,
	SIDE_CHAT_BOUNDARY,
	SIDE_CHAT_BOUNDARY_TYPE,
	SIDE_CHAT_TOOLS,
	seedSideContext,
	sideChatPrompt,
	sideThreadMessages,
} from "./session.js"

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 })

const assistantCalling = (...ids: string[]) => ({
	role: "assistant" as const,
	content: ids.map((id) => ({ type: "toolCall" as const, id, name: "bash", arguments: { command: `run ${id}` } })),
	api: "openai-completions" as const,
	provider: "kimchi-dev",
	model: "kimi-k3.1-pro",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse" as const,
	timestamp: 0,
})

const toolResult = (id: string, text: string) => ({
	role: "toolResult" as const,
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text" as const, text }],
	isError: false,
	timestamp: 0,
})

const pendingResult = (id: string) => toolResult(id, PENDING_TOOL_RESULT)

const boundary = {
	role: "custom" as const,
	customType: SIDE_CHAT_BOUNDARY_TYPE,
	content: SIDE_CHAT_BOUNDARY,
	display: false,
	timestamp: 0,
}

describe("seedSideContext", () => {
	it("ends a side chat branched between turns with the boundary marker", () => {
		const inherited = [user("fix the tests"), assistantCalling("a"), toolResult("a", "ok")]

		expect(seedSideContext(inherited, 0)).toEqual([...inherited, boundary])
	})

	it("answers tool calls still running at the branch point so they don't read as its own interrupted work", () => {
		// Regression: a side chat opened while the main agent ran vitest and lint saw two unanswered
		// bash calls, read the user's "hi" as an interruption, and resumed the main task.
		const inherited = [user("remove the trigger test"), assistantCalling("vitest", "lint")]

		expect(seedSideContext(inherited, 0)).toEqual([
			...inherited,
			pendingResult("vitest"),
			pendingResult("lint"),
			boundary,
		])
	})

	it("keeps results that already finished and answers only the calls still running", () => {
		const inherited = [user("verify"), assistantCalling("vitest", "lint"), toolResult("vitest", "4 passed")]

		expect(seedSideContext(inherited, 0)).toEqual([...inherited, pendingResult("lint"), boundary])
	})

	it("leaves unanswered calls from earlier turns alone, since those were aborted rather than running", () => {
		const inherited = [user("first"), assistantCalling("aborted"), user("second")]

		expect(seedSideContext(inherited, 0)).toEqual([...inherited, boundary])
	})

	it("tells the model the main session owns the pending work and the side chat answers only the user", () => {
		expect(PENDING_TOOL_RESULT).toMatch(/main session/)
		expect(SIDE_CHAT_BOUNDARY).toMatch(/do not continue/i)
		expect(SIDE_CHAT_BOUNDARY).toMatch(/only to the user's messages below/i)
	})
})

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
