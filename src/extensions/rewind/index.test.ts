import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MockInstance } from "vitest"

// vi.mock is hoisted — factory must be self-contained (no refs to vars below).
vi.mock("node:fs", () => ({
	writeFileSync: vi.fn(),
	renameSync: vi.fn(),
}))

// Import mocked references so we can control them per-test.
import { renameSync, writeFileSync } from "node:fs"

const mockWriteFileSync = writeFileSync as unknown as MockInstance
const mockRenameSync = renameSync as unknown as MockInstance

// Import extension AFTER vi.mock so it sees the mocked fs module.
import rewindExtension from "./index.js"

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeMessageEntry(id: string, parentId: string | null, role: string, text: string) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: role as "user" | "assistant" | "developer" | "system" | "tool",
			content: [{ type: "text", text }],
		},
	}
}

function makeHeaderEntry() {
	return {
		type: "session",
		id: "session-header",
		parentId: null,
		timestamp: new Date().toISOString(),
	}
}

type AnyEntry = { id: string; parentId: string | null; [key: string]: unknown }

function makeMockSessionManager(entries: AnyEntry[], leafId: string, sessionFile: string) {
	return {
		getEntries: vi.fn(() => entries),
		getLeafId: vi.fn(() => leafId),
		getSessionFile: vi.fn(() => sessionFile),
		getEntry: vi.fn((id: string) => entries.find((e) => e.id === id)),
		getHeader: vi.fn(() => entries.find((e) => e.type === "session") ?? null),
		getBranch: vi.fn((targetId: string) => {
			const branch: AnyEntry[] = []
			let currentId: string | null = targetId
			while (currentId) {
				const entry = entries.find((e) => e.id === currentId)
				if (!entry) break
				branch.unshift(entry)
				currentId = entry.parentId
			}
			return branch
		}),
	} as unknown as ExtensionCommandContext["sessionManager"]
}

function makeMockCtx(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
	const entries = [
		makeHeaderEntry(),
		makeMessageEntry("msg-1", "session-header", "user", "Hello"),
		makeMessageEntry("msg-2", "msg-1", "assistant", "Hi there!"),
		makeMessageEntry("msg-3", "msg-2", "user", "How are you?"),
	]
	const sm = makeMockSessionManager(entries, "msg-3", "/tmp/test-session.jsonl")

	const ui = {
		select: vi.fn<() => Promise<string | undefined>>(),
		notify: vi.fn<(_msg: string, _type?: string) => void>(),
		theme: { fg: (_color: string, text: string) => text } as unknown as ExtensionUIContext["theme"],
		setStatus: vi.fn(),
		hasUI: true,
	}

	return {
		sessionManager: sm,
		ui,
		hasUI: true,
		switchSession: vi.fn<() => Promise<{ cancelled: boolean }>>(),
		...overrides,
	} as unknown as ExtensionCommandContext
}

function makePi(): ExtensionAPI {
	return {
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn(),
	} as unknown as ExtensionAPI
}

function getHandler(pi: ExtensionAPI) {
	const calls = (
		pi.registerCommand as unknown as {
			mock: { calls: Array<[string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }]> }
		}
	).mock.calls
	const rewindCall = calls.find(([name]) => name === "rewind")
	if (!rewindCall) throw new Error("rewind command not registered")
	return rewindCall[1].handler
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("rewindExtension", () => {
	it("registers the /rewind command", () => {
		const pi = makePi()
		rewindExtension(pi)
		expect(pi.registerCommand).toHaveBeenCalledOnce()
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"rewind",
			expect.objectContaining({
				description: "Rewind conversation to a previous point",
				handler: expect.any(Function),
			}),
		)
	})
})

describe("offset resolution: /rewind -1 on session with 3 messages", () => {
	beforeEach(() => {
		mockWriteFileSync.mockReset()
		mockRenameSync.mockReset()
	})

	it("target is the parentId of the last message (rewind BEFORE last user message)", async () => {
		const pi = makePi()
		const ctx = makeMockCtx()
		let capturedTarget: string | undefined
		;(ctx.sessionManager as ReturnType<typeof makeMockSessionManager>).getBranch = vi.fn((targetId: string) => {
			capturedTarget = targetId
			const entries = (ctx.sessionManager as ReturnType<typeof makeMockSessionManager>).getEntries()
			const branch: SessionEntry[] = []
			let currentId: string | null = targetId
			while (currentId) {
				const entry = entries.find((e: SessionEntry) => e.id === currentId)
				if (!entry) break
				branch.unshift(entry)
				currentId = entry.parentId
			}
			return branch
		})
		ctx.switchSession = vi.fn(async () => ({ cancelled: false }))

		rewindExtension(pi)
		const handler = getHandler(pi)
		await handler("-1", ctx)

		// -1 on session: last is msg-3 (user), its parentId is msg-2
		expect(capturedTarget).toBe("msg-2")
	})
})

describe("offset resolution: /rewind -5 on session with 2 messages", () => {
	it("notifies warning and returns gracefully", async () => {
		const entries = [
			makeHeaderEntry(),
			makeMessageEntry("msg-a", "session-header", "user", "Hello"),
			makeMessageEntry("msg-b", "msg-a", "assistant", "Hi"),
		]
		const sm = makeMockSessionManager(entries, "msg-b", "/tmp/test.jsonl")
		const ctx = makeMockCtx({ sessionManager: sm })

		const pi = makePi()
		rewindExtension(pi)
		const handler = getHandler(pi)

		await handler("-5", ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Cannot rewind 5 messages"), "warning")
	})
})

describe("offset resolution: /rewind with invalid offset", () => {
	it("notifies usage error for positive integer", async () => {
		const ctx = makeMockCtx()
		const pi = makePi()
		rewindExtension(pi)
		const handler = getHandler(pi)

		await handler("3", ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /rewind or /rewind -N", "warning")
	})

	it("notifies usage error for non-numeric args", async () => {
		const ctx = makeMockCtx()
		const pi = makePi()
		rewindExtension(pi)
		const handler = getHandler(pi)

		await handler("foo", ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /rewind or /rewind -N", "warning")
	})
})

describe("picker: /rewind with no args", () => {
	beforeEach(() => {
		mockWriteFileSync.mockReset()
		mockRenameSync.mockReset()
	})

	it("calls ui.select with formatted message choices", async () => {
		const ctx = makeMockCtx()
		ctx.ui.select = vi.fn(async () => undefined)

		const pi = makePi()
		rewindExtension(pi)
		const handler = getHandler(pi)

		await handler("", ctx)

		expect(ctx.ui.select).toHaveBeenCalledWith(
			"Rewind to before which message?",
			expect.arrayContaining([expect.stringContaining("Hello"), expect.stringContaining("How are you?")]),
		)
	})

	it("picker cancelled → switchSession not called, no notify", async () => {
		const ctx = makeMockCtx()
		ctx.ui.select = vi.fn(async () => undefined)
		ctx.switchSession = vi.fn(async () => ({ cancelled: false }))

		const pi = makePi()
		rewindExtension(pi)
		const handler = getHandler(pi)

		await handler("", ctx)

		expect(ctx.switchSession).not.toHaveBeenCalled()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("picker resolved → switchSession called with original file path", async () => {
		const ctx = makeMockCtx()
		ctx.ui.select = vi.fn(async () => "2. How are you?")
		ctx.switchSession = vi.fn(async () => ({ cancelled: false }))

		const pi = makePi()
		rewindExtension(pi)
		const handler = getHandler(pi)

		await handler("", ctx)

		// msg-3's parentId is msg-2 → rewind target = msg-2
		expect(ctx.ui.select).toHaveBeenCalled()
		expect(ctx.switchSession).toHaveBeenCalledWith("/tmp/test-session.jsonl")
	})
})

describe("performRewind file rewrite", () => {
	beforeEach(() => {
		mockWriteFileSync.mockReset()
		mockRenameSync.mockReset()
	})

	it("writes temp file then renames with correct content", async () => {
		const ctx = makeMockCtx()
		let writtenContent: string | undefined

		mockWriteFileSync.mockImplementation((path: string, content: string) => {
			if (typeof path === "string" && path.endsWith(".rewind.tmp")) {
				writtenContent = content
			}
		})
		ctx.switchSession = vi.fn(async () => ({ cancelled: false }))

		const pi = makePi()
		rewindExtension(pi)
		const handler = getHandler(pi)

		await handler("-1", ctx)

		expect(mockWriteFileSync).toHaveBeenCalledWith("/tmp/test-session.jsonl.rewind.tmp", expect.any(String))
		expect(mockRenameSync).toHaveBeenCalledWith("/tmp/test-session.jsonl.rewind.tmp", "/tmp/test-session.jsonl")

		// Verify content is valid JSON lines (header + branch entries)
		expect(writtenContent).toBeDefined()
		const lines = writtenContent?.split("\n").filter((l) => l.trim()) ?? []
		expect(lines.length).toBeGreaterThan(1)
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow()
		}
	})
})

describe("performRewind switchSession", () => {
	beforeEach(() => {
		mockWriteFileSync.mockReset()
		mockRenameSync.mockReset()
	})

	it("switchSession called with original file path", async () => {
		const ctx = makeMockCtx()
		ctx.switchSession = vi.fn(async () => ({ cancelled: false }))

		const pi = makePi()
		rewindExtension(pi)
		const handler = getHandler(pi)

		await handler("-1", ctx)

		expect(ctx.switchSession).toHaveBeenCalledWith("/tmp/test-session.jsonl")
	})

	it("switchSession cancelled → warning notify", async () => {
		const ctx = makeMockCtx()
		ctx.switchSession = vi.fn(async () => ({ cancelled: true }))

		const pi = makePi()
		rewindExtension(pi)
		const handler = getHandler(pi)

		await handler("-1", ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith("Rewind was cancelled.", "warning")
	})
})

describe("no user messages", () => {
	it("warning notify when session has only assistant messages", async () => {
		const entries = [
			makeHeaderEntry(),
			makeMessageEntry("a-1", "session-header", "assistant", "Hello!"),
			makeMessageEntry("a-2", "a-1", "assistant", "How can I help?"),
		]
		const sm = makeMockSessionManager(entries, "a-2", "/tmp/test.jsonl")
		const ctx = makeMockCtx({ sessionManager: sm })

		const pi = makePi()
		rewindExtension(pi)
		const handler = getHandler(pi)

		await handler("", ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith("No messages to rewind.", "warning")
	})
})

describe("negative offset with multiple user messages", () => {
	beforeEach(() => {
		mockWriteFileSync.mockReset()
		mockRenameSync.mockReset()
	})

	it("/rewind -2 when 2 user messages → target is the assistant before second user", async () => {
		// Session: header → u1 (user) → a1 (assistant) → u2 (user) → a2 (assistant)
		const entries = [
			makeHeaderEntry(),
			makeMessageEntry("u1", "session-header", "user", "First"),
			makeMessageEntry("a1", "u1", "assistant", "Response 1"),
			makeMessageEntry("u2", "a1", "user", "Second"),
			makeMessageEntry("a2", "u2", "assistant", "Response 2"),
		]
		const sm = makeMockSessionManager(entries, "a2", "/tmp/test.jsonl")
		let targetSeen: string | undefined
		;(sm as ReturnType<typeof makeMockSessionManager>).getBranch = vi.fn((targetId: string) => {
			targetSeen = targetId
			const branch: AnyEntry[] = []
			let currentId: string | null = targetId
			while (currentId) {
				const entry = entries.find((e) => e.id === currentId)
				if (!entry) break
				branch.unshift(entry)
				currentId = entry.parentId
			}
			return branch as unknown as SessionEntry[]
		})

		const ctx = makeMockCtx({ sessionManager: sm })
		ctx.switchSession = vi.fn(async () => ({ cancelled: false }))

		const pi = makePi()
		rewindExtension(pi)
		const handler = getHandler(pi)

		await handler("-2", ctx)

		// -2 means rewind 2 message-type entries back from leaf (a2).
		// Walk counting only user/developer messages: a2(skip)→u2(1)→a1(skip)→u1(2, stop).
		// currentId = u1, return u1.parentId = session-header
		expect(targetSeen).toBe("session-header")
	})
})
