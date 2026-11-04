import type { AgentSession, AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import type { SideChatDeps, SideChatSink } from "./controller.js"
import { SideChatController } from "./controller.js"
import type { SideChatRecord } from "./records.js"
import type { SideChatSession } from "./session.js"
import type { SideThread } from "./store.js"

const logHolder = vi.hoisted(() => ({
	current: undefined as { read: () => SideThread; append: (messages: SideThread) => void } | undefined,
}))

vi.mock("./session.js", () => ({
	SIDE_CHAT_TOOLS: ["read", "grep", "find", "ls"],
	createSideSession: vi.fn(),
	draftSteeringPrompt: vi.fn(),
	sideThreadMessages: (side: { contextLength: number; session: { messages: SideThread } }) =>
		side.session.messages.slice(side.contextLength),
}))

vi.mock("./store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./store.js")>()
	return {
		...actual,
		openSideChatLog: vi.fn((...args: Parameters<typeof actual.openSideChatLog>) => {
			return logHolder.current ?? actual.openSideChatLog(...args)
		}),
	}
})

import { createSideSession, draftSteeringPrompt } from "./session.js"

const createSideSessionMock = vi.mocked(createSideSession)
const draftSteeringPromptMock = vi.mocked(draftSteeringPrompt)

function userMessage(text: string, timestamp = Date.now()) {
	return { role: "user", content: text, timestamp } as unknown as SideThread[number]
}

function assistantMessage(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
	} as unknown as SideThread[number]
}

function fakeSideSession(overrides?: { contextLength?: number; messages?: SideThread }): {
	side: SideChatSession
	emit(event: { type: string; message?: unknown }): void
	prompt: (text: string, options?: unknown) => Promise<void>
	abort: () => Promise<void>
	dispose: () => void
	setStreaming(streaming: boolean): void
} {
	const listeners: Array<(event: AgentSessionEvent) => void> = []
	const messages = [...(overrides?.messages ?? [])] as AgentSession["messages"]
	let streaming = false
	const emit = (event: { type: string; message?: unknown }) => {
		for (const listener of listeners) listener(event as unknown as AgentSessionEvent)
	}
	const prompt = vi.fn(async (text: string) => {
		messages.push(userMessage(text) as never)
		messages.push(assistantMessage("ok") as never)
		emit({ type: "agent_start" })
		emit({ type: "message_start", message: { role: "user", content: text } })
		emit({ type: "agent_end" })
	})
	const session = {
		messages,
		prompt,
		subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener)
			return () => {
				const index = listeners.indexOf(listener)
				if (index >= 0) listeners.splice(index, 1)
			}
		}),
		abort: vi.fn(async () => {
			streaming = false
		}),
		dispose: vi.fn(),
	}
	Object.defineProperty(session, "isStreaming", { get: () => streaming })
	return {
		side: { session: session as unknown as AgentSession, contextLength: overrides?.contextLength ?? 0 },
		emit,
		prompt: prompt as unknown as (text: string, options?: unknown) => Promise<void>,
		abort: session.abort,
		dispose: session.dispose,
		setStreaming: (value: boolean) => {
			streaming = value
		},
	}
}

interface TestDeps {
	appendEntry: (customType: string, data: unknown) => void
	sendUserMessage: Mock<SideChatDeps["sendUserMessage"]>
	getThinkingLevel: () => "off"
	notify: Mock<SideChatDeps["notify"]>
	entries: Array<Record<string, unknown>>
}

function makeDeps(): TestDeps {
	const entries: Array<Record<string, unknown>> = []
	return {
		entries,
		appendEntry: (customType: string, data: unknown) => {
			const record = data as { id?: string } | null
			if (record?.id) {
				const index = entries.findIndex((e) => (e.data as { id?: string }).id === record.id)
				if (index >= 0) entries.splice(index, 1)
			}
			entries.push({ type: "custom", customType, data })
		},
		sendUserMessage: vi.fn(),
		getThinkingLevel: () => "off",
		notify: vi.fn(),
	}
}

function makeCtx(deps: TestDeps, options?: { idle?: boolean }): ExtensionContext {
	return {
		cwd: "/tmp",
		sessionManager: {
			getSessionId: () => "main-session",
			getLeafId: () => null,
			getSessionFile: () => undefined, // memory log
			getSessionDir: () => "/tmp/sessions",
			getCwd: () => "/tmp",
			getEntries: () => deps.entries,
		},
		isIdle: vi.fn(() => options?.idle ?? false),
	} as unknown as ExtensionContext
}

interface CapturedSink {
	sink: SideChatSink
	calls: {
		addInfo: string[]
		setNotice: string[]
		addQuote: string[]
		setTitle: string[]
		commitInput: string[]
		setMode: string[]
		setDraft: string[]
		setWorking: boolean[]
		focus: number
		closed: number
		replay: SideThread[]
		events: AgentSessionEvent[]
	}
}

function makeSink(): CapturedSink {
	const calls: CapturedSink["calls"] = {
		addInfo: [],
		setNotice: [],
		addQuote: [],
		setTitle: [],
		commitInput: [],
		setMode: [],
		setDraft: [],
		setWorking: [],
		focus: 0,
		closed: 0,
		replay: [],
		events: [],
	}
	const sink: SideChatSink = {
		addInfo: (text) => calls.addInfo.push(text),
		setNotice: (text) => calls.setNotice.push(text),
		handleEvent: (event) => calls.events.push(event),
		replay: (messages) => calls.replay.push(messages),
		addQuote: (quote) => calls.addQuote.push(quote),
		setTitle: (title) => calls.setTitle.push(title),
		commitInput: (text) => calls.commitInput.push(text),
		setMode: (mode) => calls.setMode.push(mode),
		setDraft: (text) => calls.setDraft.push(text),
		setWorking: (working) => calls.setWorking.push(working),
		focus: () => calls.focus++,
		closed: () => calls.closed++,
	}
	return { sink, calls }
}

function lastRecord(deps: TestDeps): SideChatRecord | undefined {
	const entry = deps.entries.findLast((e) => e.customType === "kimchi-side-chat")
	return entry?.data as SideChatRecord | undefined
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("SideChatController", () => {
	let deps: TestDeps
	let ctx: ExtensionContext
	let controller: SideChatController

	beforeEach(() => {
		vi.clearAllMocks()
		logHolder.current = undefined
		deps = makeDeps()
		ctx = makeCtx(deps)
		controller = new SideChatController(deps)
	})

	it("opens a side chat branched from the main session's leaf", async () => {
		const side = fakeSideSession({ contextLength: 3 })
		createSideSessionMock.mockResolvedValue(side.side)
		const captured = makeSink()

		await controller.open(ctx, {}, () => captured.sink)
		await flush()

		expect(createSideSessionMock).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({ branchLeafId: null, fresh: false, thread: [] }),
		)
		expect(controller.isActive).toBe(true)
		expect(captured.calls.focus).toBe(1)
		expect(captured.calls.addInfo.some((text) => text.includes("Branched from the main session"))).toBe(true)
		expect(captured.calls.addInfo.at(-1)).toContain("read-only tools")
	})

	it("quotes the opening selection and titles a fresh chat from it", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession().side)
		const captured = makeSink()

		await controller.open(ctx, { quote: "some code" }, () => captured.sink)

		expect(captured.calls.addQuote).toEqual(["some code"])
	})

	it("routes a question through the side session and names the chat from it", async () => {
		const side = fakeSideSession()
		createSideSessionMock.mockResolvedValue(side.side)
		const captured = makeSink()

		await controller.open(ctx, {}, () => captured.sink)
		await flush()
		controller.submit("how does X work?")
		await flush()

		expect(captured.calls.setTitle).toEqual(["how does X work?"])
		expect(side.prompt).toHaveBeenCalledWith(
			"how does X work?",
			expect.objectContaining({ expandPromptTemplates: false }),
		)
		expect(captured.calls.commitInput).toEqual(["how does X work?"])
	})

	it("/close closes the chat and records the outcome", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession().side)
		const captured = makeSink()

		await controller.open(ctx, { prompt: "first" }, () => captured.sink)
		await flush()
		expect(controller.isActive).toBe(true)

		controller.submit("/close")
		await flush()

		expect(controller.isActive).toBe(false)
		expect(captured.calls.closed).toBe(1)
		expect(lastRecord(deps)?.outcome).toBe("closed")
	})

	it("/close on an untouched side chat keeps it out of history", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession().side)

		await controller.open(ctx, {}, () => makeSink().sink)
		await flush()
		controller.submit("/close")
		await flush()

		expect(lastRecord(deps)).toBeUndefined()
	})

	it("/wrap drafts a steering prompt and switches to review mode", async () => {
		const side = fakeSideSession({ messages: [userMessage("decide X")] })
		createSideSessionMock.mockResolvedValue(side.side)
		const partials: ((text: string) => void)[] = []
		draftSteeringPromptMock.mockImplementation((_ctx, _thread, _extra, onPartial) => {
			partials.push(onPartial)
			return { result: Promise.resolve("steer the main agent"), abort: vi.fn() }
		})
		const captured = makeSink()

		await controller.open(ctx, { prompt: "decide X" }, () => captured.sink)
		await flush()
		controller.submit("/wrap")
		await flush()

		expect(draftSteeringPromptMock).toHaveBeenCalled()
		expect(captured.calls.setMode).toEqual(["wrapping", "review"])
		expect(captured.calls.setDraft).toContain("steer the main agent")
		expect(captured.calls.setWorking).toEqual([true, false])
	})

	it("review-mode input steers the main session when it is busy", async () => {
		const busyCtx = makeCtx(deps, { idle: false })
		createSideSessionMock.mockResolvedValue(fakeSideSession({ messages: [userMessage("decide X")] }).side)
		draftSteeringPromptMock.mockReturnValue({ result: Promise.resolve("draft"), abort: vi.fn() })
		const captured = makeSink()

		await controller.open(busyCtx, { prompt: "decide X" }, () => captured.sink)
		await flush()
		controller.submit("/wrap")
		await flush()
		controller.submit("steer the main agent")
		await flush()

		expect(deps.sendUserMessage).toHaveBeenCalledWith("steer the main agent", { deliverAs: "steer" })
		expect(deps.notify).toHaveBeenCalledWith(busyCtx, "Side chat summary sent to the main session.")
		expect(lastRecord(deps)?.outcome).toBe("sent")
		expect(controller.isActive).toBe(false)
	})

	it("review-mode input sends a plain message when the main session is idle", async () => {
		const idleCtx = makeCtx(deps, { idle: true })
		createSideSessionMock.mockResolvedValue(fakeSideSession({ messages: [userMessage("x")] }).side)
		draftSteeringPromptMock.mockReturnValue({ result: Promise.resolve("d"), abort: vi.fn() })
		const captured = makeSink()

		await controller.open(idleCtx, { prompt: "x" }, () => captured.sink)
		await flush()
		controller.submit("/wrap")
		await flush()
		controller.submit("go")
		await flush()

		expect(deps.sendUserMessage).toHaveBeenCalledWith("go")
		expect(controller.isActive).toBe(false)
	})

	it("escape aborts the wrap draft, then the stream, then returns false", async () => {
		let resolveWrap: ((text: string) => void) | undefined
		const wrapResult = new Promise<string>((resolve) => {
			resolveWrap = resolve
		})
		const abort = vi.fn(() => resolveWrap?.(""))
		draftSteeringPromptMock.mockReturnValue({ result: wrapResult, abort })
		createSideSessionMock.mockResolvedValue(fakeSideSession({ messages: [userMessage("x")] }).side)
		const captured = makeSink()

		await controller.open(ctx, { prompt: "x" }, () => captured.sink)
		await flush()
		controller.submit("/wrap")
		await flush()

		expect(controller.escape()).toBe(true)
		expect(abort).toHaveBeenCalled()
		await flush()
		expect(captured.calls.setMode.at(-1)).toBe("chat")
		expect(controller.escape()).toBe(false)
	})

	it("escape in review mode returns to chatting without sending", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession({ messages: [userMessage("x")] }).side)
		draftSteeringPromptMock.mockReturnValue({ result: Promise.resolve("draft"), abort: vi.fn() })
		const captured = makeSink()

		await controller.open(ctx, { prompt: "x" }, () => captured.sink)
		await flush()
		controller.submit("/wrap")
		await flush()
		expect(controller.escape()).toBe(true)

		expect(captured.calls.setMode.at(-1)).toBe("chat")
		expect(deps.sendUserMessage).not.toHaveBeenCalled()
		expect(controller.isActive).toBe(true)
	})

	it("resumes a recorded side chat and replays its thread", async () => {
		const record: SideChatRecord = {
			id: "side-1",
			sessionId: "main-session",
			branchLeafId: null,
			startedAt: 1000,
			updatedAt: 2000,
			title: "old chat",
			questions: 1,
		}
		const thread: SideThread = [userMessage("earlier question", 2)]
		logHolder.current = { read: () => thread, append: vi.fn() }
		createSideSessionMock.mockResolvedValue(fakeSideSession({ messages: [...thread] }).side)
		const captured = makeSink()

		await controller.open(ctx, { resume: record }, () => captured.sink)
		await flush()

		expect(captured.calls.replay).toEqual([thread])
		expect(captured.calls.addInfo.some((text) => text.includes("Reopened side chat"))).toBe(true)
	})

	it("history flushes the active chat before listing", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession().side)
		const captured = makeSink()

		await controller.open(ctx, { prompt: "asked" }, () => captured.sink)
		await flush()
		const history = controller.history(ctx)

		expect(history).toHaveLength(1)
		expect(history[0]?.questions).toBe(1)
		expect(history[0]?.title).toBe("asked")
	})

	it("opening with a different resume record replaces the active chat", async () => {
		createSideSessionMock.mockResolvedValue(fakeSideSession().side)
		const first = makeSink()
		const second = makeSink()

		await controller.open(ctx, { prompt: "first" }, () => first.sink)
		await flush()
		await controller.open(
			ctx,
			{
				resume: {
					id: "side-2",
					sessionId: "main-session",
					branchLeafId: null,
					startedAt: 1,
					updatedAt: 1,
					title: "other",
					questions: 0,
				},
			},
			() => second.sink,
		)
		await flush()

		expect(first.calls.closed).toBe(1)
		expect(second.calls.focus).toBe(1)
		expect(controller.isActive).toBe(true)
	})
})
