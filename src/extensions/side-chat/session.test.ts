import { type AgentSession, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createModel } from "../__mocks__/model-registry.js"
import { createResponseRecoveryExtension } from "../response-recovery.js"
import {
	createSideSession,
	PENDING_TOOL_RESULT,
	SIDE_CHAT_BOUNDARY,
	SIDE_CHAT_BOUNDARY_TYPE,
	SIDE_CHAT_TOOLS,
	type SideChatSession,
	seedSideContext,
	sideChatPrompt,
	sideThreadMessages,
} from "./session.js"

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()
	return {
		...actual,
		DefaultResourceLoader: class {
			async reload() {}
		},
		createAgentSession: async (options: { sessionManager: SessionManager }) => ({
			session: {
				sessionManager: options.sessionManager,
				bindExtensions: async () => {},
				setActiveToolsByName: () => {},
			} as unknown as AgentSession,
		}),
	}
})

// The child session's runtime is only handed to the stubbed createAgentSession above.
vi.mock("../../shared/model-runtime.js", () => ({ requireModelRuntime: () => ({}) }))
vi.mock("../response-recovery.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../response-recovery.js")>()
	return { ...actual, createResponseRecoveryExtension: vi.fn(() => () => {}) }
})

const mockCreateResponseRecoveryExtension = vi.mocked(createResponseRecoveryExtension)

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 })

const assistantCalling = (...ids: string[]) => assistantStopped("toolUse", ...ids)

const assistantStopped = (stopReason: "toolUse" | "aborted" | "error", ...ids: string[]) => ({
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
	stopReason,
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

	it.each([
		"aborted",
		"error",
	] as const)("adds no results for calls of a final turn that stopped as %s, which pi never sends to the provider", (stopReason) => {
		// Regression: Esc while the main agent streamed a bash call left an aborted assistant message;
		// the seeded result for its call reached Anthropic without its tool_use and failed with a 400.
		const branched = [user("print the lines"), assistantStopped(stopReason, "partial")]

		expect(seedSideContext(branched, 0)).toEqual([...branched, boundary])
	})

	it("tells the model the main session owns the pending work and the side chat answers only the user", () => {
		expect(PENDING_TOOL_RESULT).toMatch(/main session/)
		expect(SIDE_CHAT_BOUNDARY).toMatch(/do not continue/i)
		expect(SIDE_CHAT_BOUNDARY).toMatch(/only to the user's messages below/i)
	})

	it("does not claim the main agent will resume an unanswered call after an abort", () => {
		expect(PENDING_TOOL_RESULT).toContain("Owned by the main session")
		expect(PENDING_TOOL_RESULT).not.toMatch(/still running|will handle/i)
	})

	it("keeps the boundary in the model-facing context as a user message", () => {
		const [converted] = convertToLlm([boundary])

		expect(converted).toEqual({
			role: "user",
			content: [{ type: "text", text: SIDE_CHAT_BOUNDARY }],
			timestamp: 0,
		})
	})
})

function contextWith(main: SessionManager) {
	return createContext({
		cwd: "/project",
		model: createModel("test-model"),
		sessionManager: { getEntries: () => main.getEntries(), getLeafId: () => main.getLeafId() },
	})
}

function mainSessionWith(messages: Parameters<SessionManager["appendMessage"]>[0][]): SessionManager {
	const sessionManager = SessionManager.inMemory("/project")
	for (const message of messages) sessionManager.appendMessage(message)
	return sessionManager
}

function journalOf(side: SideChatSession) {
	return side.session.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
}

describe("createSideSession", () => {
	it("tracks raw branch and seeded lengths while keeping the side thread after the seed", async () => {
		const main = mainSessionWith([user("main"), assistantCalling("running")])

		const side = await createSideSession(contextWith(main), {
			branchLeafId: main.getLeafId(),
			fresh: false,
			thinkingLevel: "off",
			thread: [user("side")],
		})

		expect(side.branchedMessages).toBe(2)
		expect(side.seededLength).toBe(4)
		const journal = journalOf(side)
		expect(journal.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "custom", "user"])
		expect(journal[3]).toMatchObject({ customType: SIDE_CHAT_BOUNDARY_TYPE, content: SIDE_CHAT_BOUNDARY })
		expect(sideThreadMessages(side)).toEqual([user("side")])
	})

	it("skips main-session seeding for a fresh side chat", async () => {
		const main = mainSessionWith([user("main")])

		const side = await createSideSession(contextWith(main), {
			branchLeafId: main.getLeafId(),
			fresh: true,
			thinkingLevel: "off",
			thread: [user("fresh side")],
		})

		expect(side.branchedMessages).toBe(0)
		expect(side.seededLength).toBe(0)
		expect(sideThreadMessages(side)).toEqual([user("fresh side")])
	})

	it("carries a compacted main session's summary, then answers its running calls before the boundary", async () => {
		const main = mainSessionWith([user("old work")])
		const kept = main.appendMessage(user("continue"))
		main.appendCompaction("Earlier: fixed the parser", kept, 50_000)
		main.appendMessage(assistantCalling("running"))

		const side = await createSideSession(contextWith(main), {
			branchLeafId: main.getLeafId(),
			fresh: false,
			thinkingLevel: "off",
			thread: [user("side")],
		})

		const journal = journalOf(side)
		expect(journal.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
			"toolResult",
			"custom",
			"user",
		])
		expect(journal[0]).toMatchObject({ summary: "Earlier: fixed the parser" })
		expect(journal[3]).toMatchObject({ toolCallId: "running", content: [{ text: PENDING_TOOL_RESULT }] })
		expect(side.branchedMessages).toBe(3)
		expect(side.seededLength).toBe(5)
		expect(sideThreadMessages(side)).toEqual([user("side")])
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

describe("side session extensions", () => {
	it("suppresses headless recovery console notices in child sessions", async () => {
		await createSideSession(createContext({ model: { id: "concrete", provider: "kimchi-dev" } }), {
			branchLeafId: null,
			fresh: true,
			thinkingLevel: "high",
		})
		expect(mockCreateResponseRecoveryExtension).toHaveBeenCalledWith({ headlessNotices: "suppress" })
	})
})

describe("sideThreadMessages", () => {
	it("drops the inherited main-session context", () => {
		const side = {
			session: sessionWith([user("main"), user("main follow-up"), user("side")]),
			seededLength: 2,
			branchedMessages: 2,
		}

		expect(sideThreadMessages(side)).toEqual([user("side")])
	})

	it("keeps the full side thread and later turns after its context compacts", () => {
		const session = sessionWith([user("main"), user("main follow-up"), user("side question")])
		const side = { session, seededLength: 2, branchedMessages: 2 }
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
