import type { CompactionResult } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	type InlineCompactCompactionModule,
	type InlineCompactOptions,
	type InlineCompactPatchOptions,
	installInlineCompactPatch,
	loadDefaultCompactionModule,
} from "./upstream-inline-compact-patch.js"

type EventRecord = Record<string, unknown>

class FakeRunner {
	_kimchiInlineCompact?: (options?: InlineCompactOptions) => Promise<CompactionResult>
	assertActive = vi.fn()

	createContext(): object {
		return { existing: true }
	}
}

class FakeSession {
	model: unknown = { provider: "test", id: "model" }
	thinkingLevel: unknown = "low"
	agent = {
		state: { messages: ["old-message"] as unknown[] },
		streamFn: vi.fn(),
	}
	_compactionAbortController?: AbortController
	_autoCompactionAbortController?: AbortController
	_inlineCompactionAbortController?: AbortController
	events: EventRecord[] = []
	disconnect = vi.fn()
	originalAbortCalls = 0
	originalAbortCompactionCalls = 0
	boundRunner?: FakeRunner
	branch: unknown[] = [{ type: "message", id: "m1" }]
	entries: unknown[] = [...this.branch]
	sessionManager = {
		getBranch: vi.fn(() => this.branch),
		getEntries: vi.fn(() => this.entries),
		appendCompaction: vi.fn(
			(summary: string, firstKeptEntryId: string, tokensBefore: number, details: unknown, fromExtension: boolean) => {
				this.entries.push({
					type: "compaction",
					summary,
					firstKeptEntryId,
					tokensBefore,
					details,
					fromExtension,
				})
			},
		),
		buildSessionContext: vi.fn(() => ({ messages: ["compacted-message"] as unknown[] })),
	}
	settingsManager = {
		getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 })),
	}
	_getCompactionRequestAuth = vi.fn(async () => ({ apiKey: "key", headers: { "x-test": "1" } }))
	_extensionRunner = {
		hasHandlers: vi.fn((_event: string): boolean => false),
		emit: vi.fn(async (_event?: unknown) => undefined as unknown),
	}
	_emit = vi.fn((event: EventRecord) => {
		this.events.push(event)
	})

	_disconnectFromAgent(): void {
		this.disconnect()
	}

	async abort(): Promise<void> {
		this.originalAbortCalls += 1
	}

	abortCompaction(): void {
		this.originalAbortCompactionCalls += 1
	}

	_bindExtensionCore(runner: FakeRunner): void {
		this.boundRunner = runner
	}
}

type MutableSessionPrototype = typeof FakeSession.prototype & {
	_kimchiInlineCompactPatch?: boolean
	inlineCompact?: (options?: InlineCompactOptions) => Promise<CompactionResult>
}

type MutableRunnerPrototype = typeof FakeRunner.prototype & {
	_kimchiInlineCompactContextPatch?: boolean
}

const originalSessionBindExtensionCore = FakeSession.prototype._bindExtensionCore
const originalSessionAbort = FakeSession.prototype.abort
const originalSessionAbortCompaction = FakeSession.prototype.abortCompaction
const originalRunnerCreateContext = FakeRunner.prototype.createContext

function inlineSession(session: FakeSession): FakeSession & {
	inlineCompact(options?: InlineCompactOptions): Promise<CompactionResult>
} {
	return session as FakeSession & {
		inlineCompact(options?: InlineCompactOptions): Promise<CompactionResult>
	}
}

function makeCompactionModule(overrides: Partial<InlineCompactCompactionModule> = {}): InlineCompactCompactionModule {
	return {
		prepareCompaction: vi.fn(() => ({
			firstKeptEntryId: "m1",
			tokensBefore: 42,
		})),
		compact: vi.fn(async () => ({
			summary: "summary",
			firstKeptEntryId: "m1",
			tokensBefore: 42,
			details: { source: "llm" },
		})),
		...overrides,
	}
}

function installWith(module: InlineCompactCompactionModule) {
	installInlineCompactPatch({
		sessionClass: FakeSession as unknown as NonNullable<InlineCompactPatchOptions["sessionClass"]>,
		runnerClass: FakeRunner as unknown as NonNullable<InlineCompactPatchOptions["runnerClass"]>,
		loadCompactionModule: async () => module,
	})
}

describe("installInlineCompactPatch", () => {
	beforeEach(() => {
		const sessionProto = FakeSession.prototype as MutableSessionPrototype
		sessionProto._bindExtensionCore = originalSessionBindExtensionCore
		sessionProto.abort = originalSessionAbort
		sessionProto.abortCompaction = originalSessionAbortCompaction
		sessionProto._kimchiInlineCompactPatch = undefined
		sessionProto.inlineCompact = undefined

		const runnerProto = FakeRunner.prototype as MutableRunnerPrototype
		runnerProto.createContext = originalRunnerCreateContext
		runnerProto._kimchiInlineCompactContextPatch = undefined
		vi.restoreAllMocks()
	})

	it("installs idempotently", () => {
		const module = makeCompactionModule()
		const sessionProto = FakeSession.prototype as MutableSessionPrototype
		const runnerProto = FakeRunner.prototype as MutableRunnerPrototype
		installWith(module)
		const inlineCompact = sessionProto.inlineCompact
		const createContext = runnerProto.createContext

		installWith(module)

		expect(sessionProto.inlineCompact).toBe(inlineCompact)
		expect(runnerProto.createContext).toBe(createContext)
	})

	it("exposes ctx.inlineCompact from ExtensionRunner contexts", async () => {
		const module = makeCompactionModule()
		installWith(module)
		const session = new FakeSession()
		const runner = new FakeRunner()

		session._bindExtensionCore(runner)
		const ctx = runner.createContext() as {
			inlineCompact?: (options?: InlineCompactOptions) => Promise<CompactionResult>
		}
		const result = await ctx.inlineCompact?.({ customInstructions: "preserve ferment" })

		expect(runner.assertActive).toHaveBeenCalledOnce()
		expect(result?.summary).toBe("summary")
		expect(session.sessionManager.appendCompaction).toHaveBeenCalledOnce()
	})

	it("runs compaction without aborting or disconnecting the session", async () => {
		const compact = vi.fn(async () => ({
			summary: "summary",
			firstKeptEntryId: "m1",
			tokensBefore: 42,
			details: { source: "llm" },
		}))
		const module = makeCompactionModule({ compact })
		installWith(module)
		const session = new FakeSession()

		const result = await inlineSession(session).inlineCompact({ customInstructions: "keep ferment", force: true })

		expect(result?.summary).toBe("summary")
		expect(session.disconnect).not.toHaveBeenCalled()
		expect(session.originalAbortCalls).toBe(0)
		expect(compact).toHaveBeenCalledWith(
			expect.anything(),
			session.model,
			"key",
			{ "x-test": "1" },
			"keep ferment",
			expect.any(AbortSignal),
			"low",
			session.agent.streamFn,
		)
		expect(session.sessionManager.appendCompaction).toHaveBeenCalledWith("summary", "m1", 42, { source: "llm" }, false)
		expect(session.agent.state.messages).toEqual(["compacted-message"])
		expect(session._extensionRunner.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "session_compact",
				fromExtension: false,
			}),
		)
		expect(session.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "compaction_start", reason: "threshold" }),
				expect.objectContaining({ type: "compaction_end", reason: "threshold", aborted: false }),
			]),
		)
	})

	it("uses extension-provided compaction results from session_before_compact", async () => {
		const compact = vi.fn()
		const module = makeCompactionModule({ compact })
		installWith(module)
		const session = new FakeSession()
		session._extensionRunner.hasHandlers = vi.fn((event: string): boolean => event === "session_before_compact")
		session._extensionRunner.emit = vi.fn(async (event: unknown) => {
			if ((event as { type?: string }).type !== "session_before_compact") return undefined
			return {
				compaction: {
					summary: "extension summary",
					firstKeptEntryId: "m2",
					tokensBefore: 100,
					details: { source: "extension" },
				},
			}
		})

		const result = await inlineSession(session).inlineCompact()

		expect(result).toMatchObject({ summary: "extension summary" })
		expect(compact).not.toHaveBeenCalled()
		expect(session.sessionManager.appendCompaction).toHaveBeenCalledWith(
			"extension summary",
			"m2",
			100,
			{ source: "extension" },
			true,
		)
	})

	it("honors force by retrying preparation with keepRecentTokens set to zero", async () => {
		const prepareCompaction = vi
			.fn()
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce({ firstKeptEntryId: "m1", tokensBefore: 42 })
		const module = makeCompactionModule({ prepareCompaction })
		installWith(module)
		const session = new FakeSession()

		await inlineSession(session).inlineCompact({ force: true })

		expect(prepareCompaction).toHaveBeenCalledTimes(2)
		expect(prepareCompaction).toHaveBeenLastCalledWith(session.branch, {
			enabled: true,
			reserveTokens: 16_384,
			keepRecentTokens: 0,
		})
	})

	it("rejects cancellation from session_before_compact", async () => {
		const module = makeCompactionModule()
		installWith(module)
		const session = new FakeSession()
		session._extensionRunner.hasHandlers = vi.fn((event: string): boolean => event === "session_before_compact")
		session._extensionRunner.emit = vi.fn(async () => ({ cancel: true }))

		await expect(inlineSession(session).inlineCompact()).rejects.toThrow("Compaction cancelled")
		expect(session.sessionManager.appendCompaction).not.toHaveBeenCalled()
		expect(session.events).toContainEqual(expect.objectContaining({ type: "compaction_end", aborted: true }))
	})

	it("preserves the original abort path while also aborting inline compaction", async () => {
		const module = makeCompactionModule({
			compact: vi.fn(
				(_preparation, _model, _apiKey, _headers, _customInstructions, signal: AbortSignal) =>
					new Promise<CompactionResult>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(new Error("Compaction cancelled")), { once: true })
					}),
			),
		})
		installWith(module)
		const session = new FakeSession()
		const promise = inlineSession(session).inlineCompact()

		await session.abort()

		expect(session.originalAbortCalls).toBe(1)
		await expect(promise).rejects.toThrow("Compaction cancelled")
	})

	it("abortCompaction cancels inline compaction and delegates to the original method", async () => {
		const module = makeCompactionModule({
			compact: vi.fn(
				(_preparation, _model, _apiKey, _headers, _customInstructions, signal: AbortSignal) =>
					new Promise<CompactionResult>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(new Error("Compaction cancelled")), { once: true })
					}),
			),
		})
		installWith(module)
		const session = new FakeSession()
		const promise = inlineSession(session).inlineCompact()

		session.abortCompaction()

		expect(session.originalAbortCompactionCalls).toBe(1)
		await expect(promise).rejects.toThrow("Compaction cancelled")
	})
})

describe("loadDefaultCompactionModule", () => {
	it("loads real PI compaction functions", async () => {
		const module = await loadDefaultCompactionModule()

		expect(module.prepareCompaction).toEqual(expect.any(Function))
		expect(module.compact).toEqual(expect.any(Function))
	})
})
