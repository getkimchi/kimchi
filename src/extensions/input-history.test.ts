import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent")
	return {
		...(actual as object),
		SessionManager: {
			list: vi.fn<
				() => Promise<
					Array<{
						path: string
						modified: Date
						id: string
						cwd: string
						created: Date
						messageCount: number
						firstMessage: string
						allMessagesText: string
					}>
				>
			>(),
			open: vi.fn(() => ({
				getEntries: vi.fn<() => unknown[]>(),
			})),
		},
		CustomEditor: class {
			addToHistory = vi.fn()
		},
	}
})

function makeMockPI() {
	const handlers: Record<string, (event: unknown, ctx?: ExtensionContext) => unknown> = {}
	return {
		pi: {
			on(event: string, handler: (e: unknown, ctx?: ExtensionContext) => unknown) {
				handlers[event] = handler
			},
			registerCommand: () => {},
			getFlag: () => undefined,
		} as unknown as ExtensionAPI,
		async trigger(event: string, payload: unknown, ctx?: ExtensionContext) {
			return handlers[event]?.(payload, ctx)
		},
	}
}

function makeMockCtx(): ExtensionContext {
	return {
		cwd: "/tmp",
		ui: {
			getEditorComponent: vi.fn(() => undefined),
			setEditorComponent: vi.fn(),
			notify: vi.fn(),
		},
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => "/tmp/session.md",
		},
	} as unknown as ExtensionContext
}

function makeUserMessageEntry(text: string): unknown {
	return {
		type: "message",
		message: {
			role: "user",
			content: text !== "" ? [{ type: "text" as const, text }] : [],
		},
	}
}

function makeAssistantMessageEntry(text: string): unknown {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text" as const, text }],
		},
	}
}

describe("inputHistoryExtension", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls setEditorComponent with a factory when past sessions contain user prompts", async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent")
		const { CustomEditor } = await import("@earendil-works/pi-coding-agent")

		vi.mocked(SessionManager.list).mockResolvedValue([
			{
				path: "/tmp/session-new",
				modified: new Date("2025-01-02"),
				id: "s1",
				cwd: "/tmp",
				created: new Date(),
				messageCount: 1,
				firstMessage: "",
				allMessagesText: "",
			},
		])
		vi.mocked(SessionManager.open).mockReturnValue({
			getEntries: () => [makeUserMessageEntry("hello from past session")],
		} as never)

		const { pi, trigger } = makeMockPI()
		const ctx = makeMockCtx()

		const { default: ext } = await import("./input-history.js")
		ext(pi)
		await trigger("session_start", {}, ctx)

		expect(SessionManager.list).toHaveBeenCalledWith("/tmp")
		expect(ctx.ui.setEditorComponent).toHaveBeenCalled()
		const factory = (ctx.ui.setEditorComponent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
		expect(typeof factory).toBe("function")

		// Calling the factory should produce a CustomEditor with addToHistory called
		const tui = {} as never
		const theme = {} as never
		const keybindings = {} as never
		const editor = factory(tui, theme, keybindings) as { addToHistory: ReturnType<typeof vi.fn> }
		expect(editor.addToHistory).toHaveBeenCalledWith("hello from past session")
	})

	it("does not call setEditorComponent when there are no past sessions", async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent")
		vi.mocked(SessionManager.list).mockResolvedValue([])
		vi.mocked(SessionManager.open).mockReturnValue({ getEntries: () => [] } as never)

		const { pi, trigger } = makeMockPI()
		const ctx = makeMockCtx()

		const { default: ext } = await import("./input-history.js")
		ext(pi)
		await trigger("session_start", {}, ctx)

		expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled()
	})

	it("wrapping factory produces editor with history loaded (observable behavior)", async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent")

		vi.mocked(SessionManager.list).mockResolvedValue([
			{
				path: "/tmp/session",
				modified: new Date("2025-01-01"),
				id: "s1",
				cwd: "/tmp",
				created: new Date(),
				messageCount: 1,
				firstMessage: "",
				allMessagesText: "",
			},
		])
		vi.mocked(SessionManager.open).mockReturnValue({
			getEntries: () => [makeUserMessageEntry("past prompt")],
		} as never)

		const { pi, trigger } = makeMockPI()
		const ctx = makeMockCtx()

		const { default: ext } = await import("./input-history.js")
		ext(pi)
		await trigger("session_start", {}, ctx)

		expect(ctx.ui.setEditorComponent).toHaveBeenCalled()

		// Extract the factory that was passed to setEditorComponent
		const wrappingFactory = (ctx.ui.setEditorComponent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as (
			t: unknown,
			th: unknown,
			tb: unknown,
		) => { addToHistory: ReturnType<typeof vi.fn> }

		// Invoke the factory the way the TUI would
		const tui = {} as never
		const theme = {} as never
		const keybindings = {} as never
		const editor = wrappingFactory(tui, theme, keybindings)

		// The editor must have addToHistory called with the loaded prompt
		expect(editor.addToHistory).toHaveBeenCalledWith("past prompt")
	})

	it("skips assistant messages and empty user content", async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent")
		const { CustomEditor } = await import("@earendil-works/pi-coding-agent")

		vi.mocked(SessionManager.list).mockResolvedValue([
			{
				path: "/tmp/session",
				modified: new Date("2025-01-01"),
				id: "s2",
				cwd: "/tmp",
				created: new Date(),
				messageCount: 1,
				firstMessage: "",
				allMessagesText: "",
			},
		])
		vi.mocked(SessionManager.open).mockReturnValue({
			getEntries: () => [
				makeAssistantMessageEntry("ignored"),
				makeUserMessageEntry("real prompt"),
				makeUserMessageEntry(""), // empty — should be skipped
			],
		} as never)

		const { pi, trigger } = makeMockPI()
		const ctx = makeMockCtx()

		const { default: ext } = await import("./input-history.js")
		ext(pi)
		await trigger("session_start", {}, ctx)

		const factory = (ctx.ui.setEditorComponent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
		const tui = {} as never
		const theme = {} as never
		const keybindings = {} as never
		const editor = factory(tui, theme, keybindings) as { addToHistory: ReturnType<typeof vi.fn> }

		// Only the non-empty user message should be added to history
		expect(editor.addToHistory).toHaveBeenCalledTimes(1)
		expect(editor.addToHistory).toHaveBeenCalledWith("real prompt")
	})

	it("filters out system-annotation messages injected by prompt-summary", async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent")

		vi.mocked(SessionManager.list).mockResolvedValue([
			{
				path: "/tmp/session",
				modified: new Date("2025-01-01"),
				id: "s4",
				cwd: "/tmp",
				created: new Date(),
				messageCount: 2,
				firstMessage: "",
				allMessagesText: "",
			},
		])
		vi.mocked(SessionManager.open).mockReturnValue({
			getEntries: () => [
				makeUserMessageEntry("<system-annotation>Prompt summary (1.2s)</system-annotation>"),
				makeUserMessageEntry("real user prompt"),
			],
		} as never)

		const { pi, trigger } = makeMockPI()
		const ctx = makeMockCtx()

		const { default: ext } = await import("./input-history.js")
		ext(pi)
		await trigger("session_start", {}, ctx)

		const factory = (ctx.ui.setEditorComponent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
		const editor = factory({} as never, {} as never, {} as never) as { addToHistory: ReturnType<typeof vi.fn> }

		// annotation must be excluded; only the real prompt reaches history
		expect(editor.addToHistory).toHaveBeenCalledTimes(1)
		expect(editor.addToHistory).toHaveBeenCalledWith("real user prompt")
	})

	it("handles corrupted session files gracefully (does not throw)", async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent")

		vi.mocked(SessionManager.list).mockResolvedValue([
			{
				path: "/tmp/bad-session",
				modified: new Date("2025-01-01"),
				id: "s3",
				cwd: "/tmp",
				created: new Date(),
				messageCount: 1,
				firstMessage: "",
				allMessagesText: "",
			},
		])
		vi.mocked(SessionManager.open).mockImplementation(() => {
			throw new Error("corrupt session file")
		})

		const { pi, trigger } = makeMockPI()
		const ctx = makeMockCtx()

		const { default: ext } = await import("./input-history.js")
		ext(pi)

		await expect(trigger("session_start", {}, ctx)).resolves.not.toThrow()
		// Should gracefully degrade — no setEditorComponent call
		expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled()
	})

	it("excludes the current session from history", async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent")

		vi.mocked(SessionManager.list).mockResolvedValue([
			{
				path: "/tmp/session-current",
				modified: new Date("2025-01-02"),
				id: "current",
				cwd: "/tmp",
				created: new Date(),
				messageCount: 1,
				firstMessage: "",
				allMessagesText: "",
			},
			{
				path: "/tmp/session-old",
				modified: new Date("2025-01-01"),
				id: "old",
				cwd: "/tmp",
				created: new Date(),
				messageCount: 1,
				firstMessage: "",
				allMessagesText: "",
			},
		])
		vi.mocked(SessionManager.open).mockImplementation(
			(path: string) =>
				({
					getEntries: () =>
						path === "/tmp/session-current"
							? [makeUserMessageEntry("current session prompt")]
							: [makeUserMessageEntry("old session prompt")],
				}) as never,
		)

		const { pi, trigger } = makeMockPI()
		const ctx = {
			...makeMockCtx(),
			sessionManager: {
				getSessionId: () => "test-session",
				getSessionFile: () => "/tmp/session-current",
			},
		} as unknown as ExtensionContext

		const { default: ext } = await import("./input-history.js")
		ext(pi)
		await trigger("session_start", {}, ctx)

		const factory = (ctx.ui.setEditorComponent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
		const editor = factory({} as never, {} as never, {} as never) as { addToHistory: ReturnType<typeof vi.fn> }

		// Only the old session prompt should be loaded
		expect(editor.addToHistory).toHaveBeenCalledTimes(1)
		expect(editor.addToHistory).toHaveBeenCalledWith("old session prompt")
	})

	it("loads messages newest-first within each session", async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent")

		vi.mocked(SessionManager.list).mockResolvedValue([
			{
				path: "/tmp/session",
				modified: new Date("2025-01-01"),
				id: "s6",
				cwd: "/tmp",
				created: new Date(),
				messageCount: 2,
				firstMessage: "",
				allMessagesText: "",
			},
		])
		vi.mocked(SessionManager.open).mockReturnValue({
			getEntries: () => [makeUserMessageEntry("older prompt"), makeUserMessageEntry("newer prompt")],
		} as never)

		const { pi, trigger } = makeMockPI()
		const ctx = makeMockCtx()

		const { default: ext } = await import("./input-history.js")
		ext(pi)
		await trigger("session_start", {}, ctx)

		const factory = (ctx.ui.setEditorComponent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
		const editor = factory({} as never, {} as never, {} as never) as { addToHistory: ReturnType<typeof vi.fn> }

		// Reverse loop loads oldest first, newest last — so "newer prompt" (loaded
		// last) is the most recent in the up-arrow sequence.
		expect(editor.addToHistory).toHaveBeenCalledTimes(2)
		expect(editor.addToHistory).toHaveBeenNthCalledWith(1, "older prompt")
		expect(editor.addToHistory).toHaveBeenNthCalledWith(2, "newer prompt")
	})

	it("filters out forked/subagent sessions via parentSessionPath", async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent")

		vi.mocked(SessionManager.list).mockResolvedValue([
			{
				path: "/tmp/forked-session",
				modified: new Date("2025-01-02"),
				id: "fork",
				cwd: "/tmp",
				created: new Date(),
				messageCount: 1,
				firstMessage: "",
				allMessagesText: "",
				parentSessionPath: "/tmp/parent-session",
			},
			{
				path: "/tmp/regular-session",
				modified: new Date("2025-01-01"),
				id: "regular",
				cwd: "/tmp",
				created: new Date(),
				messageCount: 1,
				firstMessage: "",
				allMessagesText: "",
			},
		])
		vi.mocked(SessionManager.open).mockImplementation(
			(path: string) =>
				({
					getEntries: () =>
						path === "/tmp/forked-session"
							? [makeUserMessageEntry("subagent prompt")]
							: [makeUserMessageEntry("real prompt")],
				}) as never,
		)

		const { pi, trigger } = makeMockPI()
		const ctx = makeMockCtx()

		const { default: ext } = await import("./input-history.js")
		ext(pi)
		await trigger("session_start", {}, ctx)

		const factory = (ctx.ui.setEditorComponent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
		const editor = factory({} as never, {} as never, {} as never) as { addToHistory: ReturnType<typeof vi.fn> }

		expect(editor.addToHistory).toHaveBeenCalledTimes(1)
		expect(editor.addToHistory).toHaveBeenCalledWith("real prompt")
	})

	it("filters out orchestrator system messages", async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent")

		vi.mocked(SessionManager.list).mockResolvedValue([
			{
				path: "/tmp/session",
				modified: new Date("2025-01-01"),
				id: "s7",
				cwd: "/tmp",
				created: new Date(),
				messageCount: 2,
				firstMessage: "",
				allMessagesText: "",
			},
		])
		vi.mocked(SessionManager.open).mockReturnValue({
			getEntries: () => [
				makeUserMessageEntry("[Orchestrator — automated system instruction, not a user message]\n\nStop exploring."),
				makeUserMessageEntry("real user prompt"),
			],
		} as never)

		const { pi, trigger } = makeMockPI()
		const ctx = makeMockCtx()

		const { default: ext } = await import("./input-history.js")
		ext(pi)
		await trigger("session_start", {}, ctx)

		const factory = (ctx.ui.setEditorComponent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
		const editor = factory({} as never, {} as never, {} as never) as { addToHistory: ReturnType<typeof vi.fn> }

		expect(editor.addToHistory).toHaveBeenCalledTimes(1)
		expect(editor.addToHistory).toHaveBeenCalledWith("real user prompt")
	})
})
