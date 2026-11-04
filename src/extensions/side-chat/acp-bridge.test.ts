import type { AgentSession, AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SideChatAcpBridge, type SideChatUpdate } from "./acp-bridge.js"
import type { SideChatDeps } from "./controller.js"
import type { SideChatSession } from "./session.js"
import type { SideThread } from "./store.js"

vi.mock("./session.js", () => ({
	SIDE_CHAT_TOOLS: ["read", "grep", "find", "ls"],
	createSideSession: vi.fn(),
	draftSteeringPrompt: vi.fn(),
	sideThreadMessages: (side: { contextLength: number; session: { messages: SideThread } }) =>
		side.session.messages.slice(side.contextLength),
}))

import { createSideSession, draftSteeringPrompt } from "./session.js"

const createSideSessionMock = vi.mocked(createSideSession)
const draftSteeringPromptMock = vi.mocked(draftSteeringPrompt)

function userMessage(text: string) {
	return { role: "user", content: text, timestamp: Date.now() } as unknown as SideThread[number]
}

function assistantMessage(text: string, stopReason = "stop", errorMessage?: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
	} as unknown as SideThread[number]
}

/** A scripted side session: prompt() runs a canned turn with streaming events. */
function fakeSideSession(options?: { contextLength?: number; answer?: string }): {
	side: SideChatSession
	prompt: ReturnType<typeof vi.fn>
	stream: boolean
	pending: string[]
} {
	const listeners: Array<(event: AgentSessionEvent) => void> = []
	const state = { streaming: false, pending: [] as string[] }
	const emit = (event: { type: string; message?: unknown }) => {
		for (const listener of listeners) listener(event as unknown as AgentSessionEvent)
	}
	const answer = options?.answer ?? "the answer"
	const prompt = vi.fn(async (text: string) => {
		state.pending.push(text)
		if (state.streaming) return // follow-up queued, not answered now
		state.streaming = true
		emit({ type: "agent_start" })
		const user = userMessage(text)
		const channel = Object.assign(user as { content: unknown }, {})
		emit({ type: "message_start", message: channel })
		const partial = { role: "assistant", content: [{ type: "text", text: answer.slice(0, 4) }] }
		emit({ type: "message_start", message: partial })
		emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: answer }] } })
		emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" },
		})
		messages.push(userMessage(text) as never)
		messages.push(assistantMessage(answer) as never)
		state.streaming = false
		emit({ type: "agent_end" })
	})
	const messages: SideThread = []
	const session = {
		messages,
		prompt: undefined as unknown,
		subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener)
			return () => {
				const index = listeners.indexOf(listener)
				if (index >= 0) listeners.splice(index, 1)
			}
		}),
		abort: vi.fn(async () => {
			state.streaming = false
		}),
		dispose: vi.fn(),
	}
	session.prompt = prompt
	Object.defineProperty(session, "isStreaming", { get: () => state.streaming })
	return {
		side: { session: session as unknown as AgentSession, contextLength: options?.contextLength ?? 0 },
		prompt: prompt as unknown as ReturnType<typeof vi.fn>,
		stream: state.streaming,
		pending: state.pending,
	}
}

function makeCtx(): ExtensionContext {
	return {
		cwd: "/tmp",
		sessionManager: {
			getSessionId: () => "main-session",
			getLeafId: () => null,
			getSessionFile: () => undefined,
			getSessionDir: () => "/tmp/sessions",
			getCwd: () => "/tmp",
			getEntries: () => entries,
		},
		isIdle: vi.fn(() => true),
	} as unknown as ExtensionContext
}

let entries: Array<Record<string, unknown>>
let deps: SideChatDeps
const sentToMain: Array<{ text: string; options?: unknown }> = []

function makeDeps(): SideChatDeps {
	return {
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		sendUserMessage: (text, options) => {
			sentToMain.push({ text, options })
		},
		getThinkingLevel: () => "off",
		notify: vi.fn(),
	}
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("SideChatAcpBridge", () => {
	let bridge: SideChatAcpBridge
	let updates: SideChatUpdate[]

	beforeEach(() => {
		vi.clearAllMocks()
		entries = []
		sentToMain.length = 0
		deps = makeDeps()
		bridge = new SideChatAcpBridge(makeCtx(), deps)
		updates = []
	})

	it("streams opened → user_message → assistant turn → working(false)", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession({ contextLength: 5 }).side)
		bridge.subscribe((update) => updates.push(update))

		const snapshot = await bridge.open({})
		expect(updates[0]).toEqual({
			type: "opened",
			snapshot: expect.objectContaining({ title: "New side chat", fresh: false, thread: [] }),
		})
		const origin = updates.find((update) => update.type === "notice")
		expect(origin).toMatchObject({ text: expect.stringContaining("Branched from the main session") })
		await flush()
		expect(snapshot.contextLength).toBe(5)

		const status = bridge.prompt("what is X?")
		await flush()

		expect(status).toEqual({ status: "started" })
		const types = updates.map((update) => update.type)
		expect(types).toContain("user_message")
		expect(types).toContain("assistant_delta")
		expect(types).toContain("assistant_message")
		// The agent_end turn closes with working(false), then the status-line clear.
		expect(types.at(-2)).toBe("working")
		expect(updates.at(-2)).toEqual({ type: "working", working: false })
		expect(updates.at(-1)).toEqual({ type: "notice", text: "", transient: true })
		const userTexts = updates.filter((u) => u.type === "user_message").map((u) => u.text)
		expect(userTexts).toEqual(["what is X?"])
		const final = updates.find((u) => u.type === "assistant_message")
		expect(final).toMatchObject({ text: "the answer", stopReason: "stop" })
	})

	it("names the chat from the first question", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession().side)
		bridge.subscribe((update) => updates.push(update))

		await bridge.open({})
		await flush()
		bridge.prompt("how do chips work?")
		await flush()

		expect(updates).toContainEqual({ type: "titled", title: "how do chips work?" })
	})

	it("marks prompts queued while the side session streams", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession().side)
		await bridge.open({})
		expect(bridge.prompt("first")).toEqual({ status: "started" })
	})

	it("wrap returns the draft and wraps send_to_main closes with outcome sent", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession().side)
		draftSteeringPromptMock.mockImplementation((_ctx, _thread, _extra, onPartial) => {
			onPartial("draft par")
			return { result: Promise.resolve("draft partial is now complete"), abort: vi.fn() }
		})
		bridge.subscribe((update) => updates.push(update))

		await bridge.open({ prompt: "decide the retry policy" })
		await flush()
		const { draft } = await bridge.wrap("")
		expect(draft).toBe("draft partial is now complete")
		expect(updates).toContainEqual({ type: "wrap_draft", text: "draft par", final: false })
		expect(updates).toContainEqual({ type: "wrap_draft", text: "draft partial is now complete", final: true })

		await bridge.sendToMain("draft partial is now complete (edited)")
		expect(sentToMain).toEqual([{ text: "draft partial is now complete (edited)", options: undefined }])
		expect(updates.at(-1)).toEqual({ type: "closed", outcome: "sent" })
	})

	it("close emits closed with outcome closed", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession().side)
		bridge.subscribe((update) => updates.push(update))

		await bridge.open({})
		await flush()
		await bridge.close()

		expect(updates.at(-1)).toEqual({ type: "closed", outcome: "closed" })
	})

	it("replays an opened snapshot to late subscribers", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession().side)
		await bridge.open({ prompt: "history please" })
		await flush()

		bridge.subscribe((update) => updates.push(update))

		expect(updates[0]?.type).toBe("opened")
		const snapshot = updates[0]?.type === "opened" ? updates[0].snapshot : undefined
		expect(snapshot?.thread).toEqual([
			{ role: "user", text: "history please" },
			{ role: "assistant", text: "the answer" },
		])
	})

	it("replays closed to subscribers joining after the chat ended", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession().side)
		await bridge.open({})
		await flush()
		await bridge.close()

		bridge.subscribe((update) => updates.push(update))

		expect(updates).toEqual([{ type: "closed", outcome: "closed" }])
	})

	it("history lists persisted chats after a question", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession().side)
		await bridge.open({ prompt: "listed?" })
		await flush()

		const history = bridge.history()
		expect(history).toHaveLength(1)
		expect(history[0]?.title).toBe("listed?")
		expect(history[0]?.questions).toBe(1)
	})

	it("prompt throws when no side chat is open", () => {
		expect(() => bridge.prompt("hello")).toThrow("No side chat is open.")
	})
})
