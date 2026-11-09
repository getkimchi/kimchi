/**
 * Publish tests for the side-chat lifecycle facts (side-chat-events.ts):
 * opening, asking, reopening from history, and wrapping up must each put
 * their fact on the pi.events bus, with booleans/counts only (no text).
 */

import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createCommandContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createSideChatHost } from "../__mocks__/side-chat-host.js"
import type * as Divider from "./divider.js"
import type * as FocusChrome from "./focus-chrome.js"
import type * as Harness from "./harness.js"
import sideChatExtension from "./index.js"
import type * as Panel from "./panel.js"
import type { SideChatRecord } from "./records.js"
import type * as Session from "./session.js"
import { SIDE_CHAT_EVENTS } from "./side-chat-events.js"
import type * as Store from "./store.js"

/** Latest fake panel; the panel mock pushes every instance here. */
interface TestPanel {
	submit(text: string): void
	currentMode: string
	infos: string[]
	editorText: string
	disposed: boolean
}
const panels = vi.hoisted(() => [] as TestPanel[])
const hostRef = vi.hoisted(() => ({ host: undefined as unknown }))
const sideState = vi.hoisted(() => ({
	/** What the mocked sideThreadMessages returns. */
	thread: [] as Array<{ role: string }>,
	/** What the mocked openSideChatLog reads. */
	storedThread: [] as Array<{ role: string }>,
	/** Draft the mocked draftSteeringPrompt resolves with. */
	wrapDraft: "drafted steering message",
	/** When set, the mocked createSideSession rejects (session never starts). */
	startError: undefined as Error | undefined,
	/** When set, the mocked side-chat log read throws (corrupt transcript). */
	logError: undefined as Error | undefined,
	/** When set, the mocked side session prompt rejects (message never persists). */
	promptError: undefined as Error | undefined,
}))

vi.mock("./harness.js", async (importOriginal) => {
	const actual = await importOriginal<typeof Harness>()
	return {
		...actual,
		installSideChatHarnessPatch: () => true,
		getSideChatHost: () => hostRef.host,
		addCompositor: () => () => {},
		addWheelInterceptor: () => () => {},
		addMouseInterceptor: () => () => {},
		addFocusGuard: () => () => {},
	}
})

vi.mock("./panel.js", () => {
	class FakeSideChatPanel {
		currentMode = "chat"
		root = {}
		/** Last text set into the editor (what the user would see on screen). */
		editorText = ""
		/** Info lines shown in the transcript. */
		infos: string[] = []
		disposed = false
		editor = {
			setText: (text: string) => {
				this.editorText = text
			},
			addToHistory: () => {},
		}
		submitted: string[] = []
		constructor(
			private options: {
				onSubmit: (text: string) => void
			},
		) {
			panels.push(this)
		}
		/** Drive the panel the way pressing enter in its editor would. */
		submit(text: string): void {
			this.submitted.push(text)
			this.options.onSubmit(text)
		}
		setNotice() {}
		setMode(mode: string) {
			this.currentMode = mode
		}
		setWorking() {}
		addInfo(text: string) {
			this.infos.push(text)
		}
		addQuote() {}
		setTitle() {}
		focus() {}
		get isHistoryOpen() {
			return false
		}
		hideHistory() {}
		showHistory() {}
		replay() {}
		scrollAt() {
			return false
		}
		dispose() {
			this.disposed = true
		}
		handleEvent() {}
		paint() {}
	}
	return { SideChatPanel: FakeSideChatPanel as unknown as typeof Panel.SideChatPanel }
})

vi.mock("./session.js", async (importOriginal) => {
	const actual = await importOriginal<typeof Session>()
	return {
		...actual,
		createSideSession: async () => {
			if (sideState.startError) throw sideState.startError
			return {
				session: {
					subscribe: () => () => {},
					dispose: () => {},
					abort: async () => {},
					prompt: async () => {
						if (sideState.promptError) throw sideState.promptError
					},
					isStreaming: false,
				},
				contextLength: 0,
			}
		},
		sideThreadMessages: () => sideState.thread,
		draftSteeringPrompt: () => ({ result: Promise.resolve(sideState.wrapDraft), abort: () => {} }),
	}
})

vi.mock("./store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof Store>()
	return {
		...actual,
		openSideChatLog: () => ({
			read: () => {
				if (sideState.logError) throw sideState.logError
				return sideState.storedThread
			},
			append: () => {},
		}),
		persistableThread: (thread: unknown) => thread,
	}
})

vi.mock("./focus-chrome.js", async (importOriginal) => {
	const actual = await importOriginal<typeof FocusChrome>()
	return { ...actual, applyFocusChrome: () => () => {} }
})

vi.mock("./divider.js", async (importOriginal) => {
	const actual = await importOriginal<typeof Divider>()
	return {
		...actual,
		PaneDivider: class {
			component = {}
			paint() {}
			handleMouse() {
				return false
			}
		} as unknown as typeof Divider.PaneDivider,
	}
})

const user = (text: string) => ({ role: "user", content: text })
const assistant = (text: string) => ({ role: "assistant", content: text })

describe("side-chat lifecycle fact publishing", () => {
	beforeEach(() => {
		const { host } = createSideChatHost()
		Object.assign(host, { mainEditor: () => ({ focused: false, render: () => [] }) })
		hostRef.host = host
		panels.length = 0
		sideState.thread = []
		sideState.storedThread = []
		sideState.startError = undefined
		sideState.logError = undefined
		sideState.promptError = undefined
	})

	function setup() {
		const pi = createExtensionApi()
		// The shared mock predates pi's sendUserMessage (only sendMessage is
		// mocked); /wrap's send-to-main path needs it.
		Object.assign(pi.api, { sendUserMessage: vi.fn() })
		sideChatExtension(pi.api)
		return pi
	}

	function makeContext(entries: SessionEntry[] = [], select?: (labels: string[]) => string): ExtensionCommandContext {
		const ctx = createCommandContext()
		Object.assign(ctx, {
			sessionManager: {
				getSessionId: () => "main-session",
				getLeafId: () => "leaf-1",
				getEntries: () => entries,
				getSessionDir: () => "/tmp",
				getSessionFile: () => undefined,
				getBranch: () => [],
				getHeader: () => null,
			},
			...(select
				? { ui: { ...ctx.ui, select: vi.fn(async (_title: string, labels: string[]) => select(labels)) } }
				: {}),
		})
		return ctx
	}

	/** Records emitted on the bus: [channel, payload] tuples. */
	function published(pi: ReturnType<typeof createExtensionApi>): Array<[string, unknown]> {
		return (pi.api.events.emit as unknown as { mock: { calls: Array<[string, unknown]> } }).mock.calls
	}

	/** The panel of the currently open side chat. */
	function openPanel(): TestPanel {
		const panel = panels[panels.length - 1]
		if (!panel) throw new Error("no side chat panel was created")
		return panel
	}

	/** Let pending prompt/send continuations (post-ready emits) settle. */
	async function flush(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0))
	}

	it("publishes side-chat:started (quotedSelection false) when /btw opens a chat", async () => {
		const pi = setup()
		const ctx = makeContext()

		await pi.getRegisteredCommand("btw").handler("", ctx)

		expect(published(pi)).toContainEqual(["side-chat:started", { quotedSelection: false }])
	})

	it("publishes side-chat:started with quotedSelection true when opened with a selection", async () => {
		const pi = setup()
		const { host, setSelection } = createSideChatHost()
		Object.assign(host, { mainEditor: () => ({ focused: false, render: () => [] }) })
		hostRef.host = host
		setSelection({ bounds: { x: 0, y: 0, width: 1, height: 1 } as never, text: "selected text" })
		const ctx = makeContext()

		await pi.getRegisteredCommand("btw").handler("", ctx)

		expect(published(pi)).toContainEqual(["side-chat:started", { quotedSelection: true }])
	})

	it("does not publish started again when /btw focuses the already-open chat", async () => {
		const pi = setup()
		const ctx = makeContext()

		await pi.getRegisteredCommand("btw").handler("", ctx)
		await pi.getRegisteredCommand("btw").handler("", ctx)

		expect(published(pi).filter(([channel]) => channel === SIDE_CHAT_EVENTS.STARTED)).toHaveLength(1)
	})

	it("publishes side-chat:message_sent per question, counting user messages 1-based", async () => {
		const pi = setup()
		const ctx = makeContext()

		await pi.getRegisteredCommand("btw").handler("first question?", ctx)
		// The fact is published only after the ready guard confirms a live
		// side session, i.e. asynchronously from the submit itself.
		await vi.waitFor(() =>
			expect(published(pi).filter(([channel]) => channel === SIDE_CHAT_EVENTS.MESSAGE_SENT)).toHaveLength(1),
		)
		openPanel().submit("second question?")
		await vi.waitFor(() =>
			expect(published(pi).filter(([channel]) => channel === SIDE_CHAT_EVENTS.MESSAGE_SENT)).toHaveLength(2),
		)

		const sent = published(pi).filter(([channel]) => channel === SIDE_CHAT_EVENTS.MESSAGE_SENT)
		expect(sent).toEqual([
			["side-chat:message_sent", { quotedSelection: false, messageIndex: 1 }],
			["side-chat:message_sent", { quotedSelection: false, messageIndex: 2 }],
		])
	})

	it("marks message_sent quoted_selection when the message carries a quoted selection", async () => {
		const pi = setup()
		const ctx = makeContext()

		await pi.getRegisteredCommand("btw").handler("", ctx)
		openPanel().submit("> quoted from the transcript\n\nwhat about this?")
		await vi.waitFor(() =>
			expect(published(pi).some(([channel]) => channel === SIDE_CHAT_EVENTS.MESSAGE_SENT)).toBe(true),
		)

		expect(published(pi)).toContainEqual(["side-chat:message_sent", { quotedSelection: true, messageIndex: 1 }])
	})

	it("does not publish message_sent when the side session fails to start (regression: dropped submit)", async () => {
		const pi = setup()
		const ctx = makeContext()
		sideState.startError = new Error("no model selected")

		await pi.getRegisteredCommand("btw").handler("question into a chat that never starts?", ctx)
		openPanel().submit("another dropped question?")
		// Deterministic wait: the failed session start surfaces in the panel.
		await vi.waitFor(() =>
			expect(openPanel().infos.some((text) => text.includes("Could not start side chat"))).toBe(true),
		)
		await flush()

		expect(published(pi).some(([channel]) => channel === SIDE_CHAT_EVENTS.MESSAGE_SENT)).toBe(false)
	})

	it("rolls the message index back when the prompt rejects before persisting", async () => {
		const pi = setup()
		const ctx = makeContext()
		sideState.promptError = new Error("provider unreachable")

		await pi.getRegisteredCommand("btw").handler("question that fails to deliver?", ctx)
		await vi.waitFor(() =>
			expect(openPanel().infos.some((text) => text.includes("Side chat error"))).toBe(true),
		)
		sideState.promptError = undefined
		openPanel().submit("retry the question?")
		await vi.waitFor(() =>
			expect(published(pi).filter(([channel]) => channel === SIDE_CHAT_EVENTS.MESSAGE_SENT)).toHaveLength(2),
		)

		// The fact for the failed submit stands (it was already published), but
		// the counter must run back so the retry — the message that actually
		// persisted — keeps its rightful index instead of skipping ahead.
		expect(published(pi).filter(([channel]) => channel === SIDE_CHAT_EVENTS.MESSAGE_SENT)).toEqual([
			["side-chat:message_sent", { quotedSelection: false, messageIndex: 1 }],
			["side-chat:message_sent", { quotedSelection: false, messageIndex: 1 }],
		])
	})

	it("does not publish message_sent for /wrap and /close commands", async () => {
		const pi = setup()
		const ctx = makeContext()

		await pi.getRegisteredCommand("btw").handler("", ctx)
		openPanel().submit("/close")
		await flush()

		expect(published(pi).some(([channel]) => channel === SIDE_CHAT_EVENTS.MESSAGE_SENT)).toBe(false)
	})

	it("publishes side-chat:history_reopened with the reopened thread's role counts", async () => {
		const pi = setup()
		const record: SideChatRecord = {
			id: "chat-1",
			sessionId: "main-session",
			branchLeafId: "leaf-1",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			title: "cached",
			questions: 3,
		}
		const entries = [{ type: "custom", customType: "kimchi-side-chat", data: record }] as unknown as SessionEntry[]
		sideState.storedThread = [user("q1"), assistant("a1"), user("q2"), assistant("a2"), user("q3")]
		const ctx = makeContext(entries, (labels) => labels[0] ?? "")

		await pi.getRegisteredCommand("btw").handler("history", ctx)

		expect(published(pi)).toContainEqual([
			"side-chat:history_reopened",
			{ messageCountUser: 3, messageCountAssistant: 2 },
		])
		// A reopen is not a fresh start.
		expect(published(pi).some(([channel]) => channel === SIDE_CHAT_EVENTS.STARTED)).toBe(false)
	})

	it("keeps message_index monotonic across a reopen when the log lost a question (record ahead)", async () => {
		const pi = setup()
		// Pre-close state: two questions were asked (the durable record says
		// so), but the saved transcript holds only one — a submit that never
		// reached the log. The next submit must get a fresh index, not repeat 2.
		const record: SideChatRecord = {
			id: "chat-1",
			sessionId: "main-session",
			branchLeafId: "leaf-1",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			title: "cached",
			questions: 2,
		}
		const entries = [{ type: "custom", customType: "kimchi-side-chat", data: record }] as unknown as SessionEntry[]
		sideState.storedThread = [user("q1"), assistant("a1")]
		const ctx = makeContext(entries, (labels) => labels[0] ?? "")

		await pi.getRegisteredCommand("btw").handler("history", ctx)
		openPanel().submit("third question?")

		await vi.waitFor(() =>
			expect(published(pi).some(([channel]) => channel === SIDE_CHAT_EVENTS.MESSAGE_SENT)).toBe(true),
		)
		expect(published(pi)).toContainEqual(["side-chat:message_sent", { quotedSelection: false, messageIndex: 3 }])
	})

	it("keeps message_index monotonic across a reopen when the record is behind the log", async () => {
		const pi = setup()
		// Mirror image: the log kept both questions, the record was written
		// before the second save (crash). The next submit must not repeat 2.
		const record: SideChatRecord = {
			id: "chat-1",
			sessionId: "main-session",
			branchLeafId: "leaf-1",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			title: "cached",
			questions: 1,
		}
		const entries = [{ type: "custom", customType: "kimchi-side-chat", data: record }] as unknown as SessionEntry[]
		sideState.storedThread = [user("q1"), assistant("a1"), user("q2")]
		const ctx = makeContext(entries, (labels) => labels[0] ?? "")

		await pi.getRegisteredCommand("btw").handler("history", ctx)
		openPanel().submit("third question?")

		await vi.waitFor(() =>
			expect(published(pi).some(([channel]) => channel === SIDE_CHAT_EVENTS.MESSAGE_SENT)).toBe(true),
		)
		expect(published(pi)).toContainEqual(["side-chat:message_sent", { quotedSelection: false, messageIndex: 3 }])
	})

	it("does not publish history_reopened when the transcript is unreadable but the record counts questions", async () => {
		const pi = setup()
		const record: SideChatRecord = {
			id: "chat-1",
			sessionId: "main-session",
			branchLeafId: "leaf-1",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			title: "cached",
			questions: 3,
		}
		const entries = [{ type: "custom", customType: "kimchi-side-chat", data: record }] as unknown as SessionEntry[]
		sideState.logError = new Error("corrupt transcript")
		const ctx = makeContext(entries, (labels) => labels[0] ?? "")

		await pi.getRegisteredCommand("btw").handler("history", ctx)
		await flush()

		// 0/0 counts would read as an empty chat and hide the data loss.
		expect(published(pi).some(([channel]) => channel === SIDE_CHAT_EVENTS.HISTORY_REOPENED)).toBe(false)
		expect(published(pi).some(([channel]) => channel === SIDE_CHAT_EVENTS.STARTED)).toBe(false)
		// The chat still opens, with the transcript-unavailable notice.
		expect(openPanel().infos.some((text) => text.includes("no longer available"))).toBe(true)
	})

	it("publishes history_reopened with 0/0 for a readable empty transcript", async () => {
		const pi = setup()
		const record: SideChatRecord = {
			id: "chat-1",
			sessionId: "main-session",
			branchLeafId: "leaf-1",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			title: "cached",
			questions: 0,
		}
		const entries = [{ type: "custom", customType: "kimchi-side-chat", data: record }] as unknown as SessionEntry[]
		const ctx = makeContext(entries, (labels) => labels[0] ?? "")

		await pi.getRegisteredCommand("btw").handler("history", ctx)

		expect(published(pi)).toContainEqual([
			"side-chat:history_reopened",
			{ messageCountUser: 0, messageCountAssistant: 0 },
		])
	})

	it("publishes side-chat:wrapped with the thread's counts when the draft goes to the main agent", async () => {
		const pi = setup()
		const ctx = makeContext()
		sideState.thread = [user("q1"), assistant("a1"), user("q2")]

		await pi.getRegisteredCommand("btw").handler("", ctx)
		const panel = openPanel()
		panel.submit("/wrap")
		// The wrap draft resolves asynchronously; wait for review mode before sending.
		await vi.waitFor(() => expect(panel.currentMode).toBe("review"))
		panel.submit("final steering text")
		// The wrap fact is published after the send is enqueued — asynchronously.
		await vi.waitFor(() => expect(published(pi).some(([channel]) => channel === SIDE_CHAT_EVENTS.WRAPPED)).toBe(true))

		expect(published(pi)).toContainEqual(["side-chat:wrapped", { messageCountUser: 2, messageCountAssistant: 1 }])
		const sendUserMessage = (pi.api as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage
		expect(sendUserMessage).toHaveBeenCalledWith("final steering text", expect.anything())
	})

	it("keeps every published payload free of side-chat text", async () => {
		const pi = setup()
		const ctx = makeContext()

		await pi.getRegisteredCommand("btw").handler("secret question?", ctx)
		openPanel().submit("> secret quote\n\nsecret follow-up?")
		await vi.waitFor(() =>
			expect(published(pi).filter(([channel]) => channel === SIDE_CHAT_EVENTS.MESSAGE_SENT)).toHaveLength(2),
		)

		for (const [, payload] of published(pi)) {
			expect(JSON.stringify(payload)).not.toContain("secret")
		}
	})
})
