import type { Api, Model } from "@earendil-works/pi-ai"
import { AgentSession, type CompactionResult, ExtensionRunner } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	type InlineCompactOptions,
	type InlineCompactPatchOptions,
	installInlineCompactPatch,
} from "./upstream-inline-compact-patch.js"

type EventRecord = Record<string, unknown>

class FakeRunner {
	_kimchiInlineCompact?: (options?: InlineCompactOptions) => Promise<CompactionResult>
	assertActive = vi.fn()

	createContext(): object {
		return { existing: true }
	}
}

/**
 * Emulates the parts of upstream AgentSession.compact() the delegation wrapper
 * interacts with, in upstream's call order: _disconnectFromAgent → await
 * this.abort() → set _compactionAbortController → auth via this.model →
 * prepare via settingsManager.getCompactionSettings() → summarize with
 * this.model/this.thinkingLevel → append + rebuild messages → finally clear
 * controller + _reconnectToAgent(). The install-time source assertion requires
 * the same `_disconnectFromAgent` / `this.abort` markers as the real method.
 */
class FakeSession {
	model: unknown = { provider: "test", id: "model" }
	thinkingLevel: unknown = "low"
	agent = {
		state: { messages: ["old-message"] as unknown[] },
		streamFn: vi.fn(),
	}
	_compactionAbortController?: AbortController
	_autoCompactionAbortController?: AbortController
	events: EventRecord[] = []
	disconnect = vi.fn()
	reconnect = vi.fn()
	originalAbortCalls = 0
	boundRunner?: FakeRunner
	branch: unknown[] = [{ type: "message", id: "m1", message: { role: "user", content: "hi" } }]
	entries: unknown[] = [...this.branch]
	/** Settings snapshots taken inside compact(), one per invocation. */
	preparedWithSettings: Array<Record<string, unknown>> = []
	/** (model, thinkingLevel, customInstructions) triples seen by the summarizer. */
	summarizeCalls: Array<{ model: unknown; thinkingLevel: unknown; customInstructions?: string }> = []
	summarize: (signal: AbortSignal) => Promise<CompactionResult> = async () => ({
		summary: "summary",
		firstKeptEntryId: "m1",
		tokensBefore: 42,
		details: { source: "llm" },
	})
	sessionManager = {
		getBranch: vi.fn(() => this.branch),
		getEntries: vi.fn(() => this.entries),
		appendCompaction: vi.fn(
			(summary: string, firstKeptEntryId: string, tokensBefore: number, details: unknown, fromExtension: boolean) => {
				this.entries.push({ type: "compaction", summary, firstKeptEntryId, tokensBefore, details, fromExtension })
			},
		),
		buildSessionContext: vi.fn(() => ({ messages: ["compacted-message"] as unknown[] })),
	}
	settingsManager = {
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
	}
	_getCompactionRequestAuth = vi.fn(async (_model: unknown) => ({ apiKey: "key", headers: { "x-test": "1" } }))
	_emit = vi.fn((event: EventRecord) => {
		this.events.push(event)
	})

	_disconnectFromAgent(): void {
		this.disconnect()
	}

	_reconnectToAgent(): void {
		this.reconnect()
	}

	async abort(): Promise<void> {
		this.originalAbortCalls += 1
	}

	abortCompaction(): void {
		this._compactionAbortController?.abort()
	}

	_bindExtensionCore(runner: FakeRunner): void {
		this.boundRunner = runner
	}

	async compact(customInstructions?: string, _force = false): Promise<CompactionResult> {
		this._disconnectFromAgent()
		await this.abort()
		this._compactionAbortController = new AbortController()
		this._emit({ type: "compaction_start", reason: "manual" })
		try {
			if (!this.model) throw new Error("No model selected")
			await this._getCompactionRequestAuth(this.model)
			this.preparedWithSettings.push(this.settingsManager.getCompactionSettings())
			this.summarizeCalls.push({ model: this.model, thinkingLevel: this.thinkingLevel, customInstructions })
			const result = await this.summarize(this._compactionAbortController.signal)
			if (this._compactionAbortController.signal.aborted) throw new Error("Compaction cancelled")
			this.sessionManager.appendCompaction(
				result.summary,
				result.firstKeptEntryId,
				result.tokensBefore,
				result.details,
				false,
			)
			this.agent.state.messages = this.sessionManager.buildSessionContext().messages
			this._emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false })
			return result
		} catch (error) {
			this._emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false })
			throw error
		} finally {
			this._compactionAbortController = undefined
			this._reconnectToAgent()
		}
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
const originalRunnerCreateContext = FakeRunner.prototype.createContext

function inlineSession(session: FakeSession): FakeSession & {
	inlineCompact(options?: InlineCompactOptions): Promise<CompactionResult>
} {
	return session as FakeSession & {
		inlineCompact(options?: InlineCompactOptions): Promise<CompactionResult>
	}
}

function install() {
	installInlineCompactPatch({
		sessionClass: FakeSession as unknown as NonNullable<InlineCompactPatchOptions["sessionClass"]>,
		runnerClass: FakeRunner as unknown as NonNullable<InlineCompactPatchOptions["runnerClass"]>,
	})
}

/** A summarizer that stays pending until its signal aborts (or is aborted already). */
function hangingSummarize(): (signal: AbortSignal) => Promise<CompactionResult> {
	return (signal) =>
		new Promise<CompactionResult>((_resolve, reject) => {
			if (signal.aborted) {
				reject(new Error("Compaction cancelled"))
				return
			}
			signal.addEventListener("abort", () => reject(new Error("Compaction cancelled")), { once: true })
		})
}

describe("installInlineCompactPatch", () => {
	beforeEach(() => {
		const sessionProto = FakeSession.prototype as MutableSessionPrototype
		sessionProto._bindExtensionCore = originalSessionBindExtensionCore
		sessionProto._kimchiInlineCompactPatch = undefined
		sessionProto.inlineCompact = undefined

		const runnerProto = FakeRunner.prototype as MutableRunnerPrototype
		runnerProto.createContext = originalRunnerCreateContext
		runnerProto._kimchiInlineCompactContextPatch = undefined
		vi.restoreAllMocks()
	})

	it("installs idempotently", () => {
		const sessionProto = FakeSession.prototype as MutableSessionPrototype
		const runnerProto = FakeRunner.prototype as MutableRunnerPrototype
		install()
		const inlineCompact = sessionProto.inlineCompact
		const createContext = runnerProto.createContext

		install()

		expect(sessionProto.inlineCompact).toBe(inlineCompact)
		expect(runnerProto.createContext).toBe(createContext)
	})

	it("installs against the real AgentSession/ExtensionRunner internals", () => {
		// The drift canary: fails when upstream renames compact()'s quiesce
		// internals (_disconnectFromAgent / this.abort) or the patched members.
		expect(() => installInlineCompactPatch()).not.toThrow()
		expect(typeof (AgentSession.prototype as { inlineCompact?: unknown }).inlineCompact).toBe("function")
		expect(
			(ExtensionRunner.prototype as { _kimchiInlineCompactContextPatch?: boolean })._kimchiInlineCompactContextPatch,
		).toBe(true)
	})

	it("rejects a session class whose compact() lacks the quiesce internals", () => {
		class DriftedSession {
			async compact(): Promise<void> {}
			_bindExtensionCore(): void {}
		}
		expect(() =>
			installInlineCompactPatch({
				sessionClass: DriftedSession as unknown as NonNullable<InlineCompactPatchOptions["sessionClass"]>,
				runnerClass: FakeRunner as unknown as NonNullable<InlineCompactPatchOptions["runnerClass"]>,
			}),
		).toThrow("incompatible with Kimchi inline compaction")
	})

	it("exposes ctx.inlineCompact from ExtensionRunner contexts", async () => {
		install()
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

	it("delegates to compact() without aborting or disconnecting the session", async () => {
		install()
		const session = new FakeSession()

		const result = await inlineSession(session).inlineCompact({ customInstructions: "keep ferment", force: true })

		expect(result?.summary).toBe("summary")
		expect(session.disconnect).not.toHaveBeenCalled()
		expect(session.originalAbortCalls).toBe(0)
		// Upstream's finally still runs (idempotent reconnect + controller clear).
		expect(session.reconnect).toHaveBeenCalledOnce()
		expect(session._compactionAbortController).toBeUndefined()
		expect(session.summarizeCalls).toEqual([
			{ model: session.model, thinkingLevel: "low", customInstructions: "keep ferment" },
		])
		expect(session.sessionManager.appendCompaction).toHaveBeenCalledWith("summary", "m1", 42, { source: "llm" }, false)
		expect(session.agent.state.messages).toEqual(["compacted-message"])
		// Delegation inherits upstream's event shapes verbatim.
		expect(session.events).toEqual([
			expect.objectContaining({ type: "compaction_start", reason: "manual" }),
			expect.objectContaining({ type: "compaction_end", reason: "manual", aborted: false }),
		])
	})

	it("restores the quiesce members after completion so later manual compactions abort again", async () => {
		install()
		const session = new FakeSession()

		await inlineSession(session).inlineCompact()
		// Shadows must be gone: a subsequent DIRECT compact() call is the manual
		// path and must quiesce normally.
		await session.compact()

		expect(session.disconnect).toHaveBeenCalledOnce()
		expect(session.originalAbortCalls).toBe(1)
		expect(Object.getOwnPropertyDescriptor(session, "_disconnectFromAgent")).toBeUndefined()
		expect(Object.getOwnPropertyDescriptor(session, "abort")).toBeUndefined()
	})

	it("restores all shadows when compaction fails", async () => {
		install()
		const session = new FakeSession()
		session.summarize = async () => {
			throw new Error("summarizer exploded")
		}
		const originalGetSettings = session.settingsManager.getCompactionSettings

		await expect(
			inlineSession(session).inlineCompact({
				force: true,
				model: { id: "other" } as unknown as Model<Api>,
				thinkingLevel: "off",
			}),
		).rejects.toThrow("summarizer exploded")

		expect(Object.getOwnPropertyDescriptor(session, "_disconnectFromAgent")).toBeUndefined()
		expect(Object.getOwnPropertyDescriptor(session, "abort")).toBeUndefined()
		expect(session.settingsManager.getCompactionSettings).toBe(originalGetSettings)
		expect(session.model).toEqual({ provider: "test", id: "model" })
		expect(session.thinkingLevel).toBe("low")
	})

	it("honors force by shadowing settings to keepRecentTokens: 0", async () => {
		// force must not rely on upstream's undefined-preparation retry: a session
		// smaller than keepRecentTokens returns a DEFINED preparation with zero
		// summarizable messages, so preparation must start from keepRecentTokens: 0.
		install()
		const session = new FakeSession()

		await inlineSession(session).inlineCompact({ force: true })

		expect(session.preparedWithSettings).toEqual([{ enabled: true, reserveTokens: 16_384, keepRecentTokens: 0 }])
	})

	it("honors explicit keepRecentTokens", async () => {
		install()
		const session = new FakeSession()

		await inlineSession(session).inlineCompact({ force: true, keepRecentTokens: 12_000 })

		expect(session.preparedWithSettings).toEqual([{ enabled: true, reserveTokens: 16_384, keepRecentTokens: 12_000 }])
	})

	it("keeps default preparation settings when force is not set", async () => {
		install()
		const session = new FakeSession()

		await inlineSession(session).inlineCompact()

		expect(session.preparedWithSettings).toEqual([{ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }])
	})

	it("routes options.model to auth and summarization, then restores the session model", async () => {
		install()
		const session = new FakeSession()
		const overrideModel: Model<Api> = {
			id: "non-reasoning-model",
			name: "Non-Reasoning Model",
			api: "openai-completions",
			provider: "kimchi-dev",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		}

		await inlineSession(session).inlineCompact({ customInstructions: "keep ferment", model: overrideModel })

		expect(session._getCompactionRequestAuth).toHaveBeenCalledWith(overrideModel)
		expect(session.summarizeCalls).toEqual([
			{ model: overrideModel, thinkingLevel: "low", customInstructions: "keep ferment" },
		])
		expect(session.model).toEqual({ provider: "test", id: "model" })
	})

	it("routes options.thinkingLevel to summarization, then restores the session level", async () => {
		install()
		const session = new FakeSession()

		await inlineSession(session).inlineCompact({ thinkingLevel: "off" })

		expect(session.summarizeCalls).toEqual([
			{ model: session.model, thinkingLevel: "off", customInstructions: undefined },
		])
		expect(session.thinkingLevel).toBe("low")
	})

	it("falls back to the session model and thinking level when overrides are omitted", async () => {
		install()
		const session = new FakeSession()

		await inlineSession(session).inlineCompact({ customInstructions: "keep ferment" })

		expect(session._getCompactionRequestAuth).toHaveBeenCalledWith(session.model)
		expect(session.summarizeCalls).toEqual([
			{ model: session.model, thinkingLevel: "low", customInstructions: "keep ferment" },
		])
	})

	it("cancels the compaction when abort() is called during summarization", async () => {
		install()
		const session = new FakeSession()
		session.summarize = hangingSummarize()
		const promise = inlineSession(session).inlineCompact()
		// Let the wrapper consume the one-shot suppression of compact()'s
		// internal quiesce abort before the external abort arrives.
		await Promise.resolve()

		await session.abort()

		await expect(promise).rejects.toThrow("Compaction cancelled")
		// The external abort was a real one: it reached the original abort path.
		expect(session.originalAbortCalls).toBe(1)
	})

	it("abortCompaction cancels inline compaction through upstream's own controller", async () => {
		install()
		const session = new FakeSession()
		session.summarize = hangingSummarize()
		const promise = inlineSession(session).inlineCompact()
		await Promise.resolve()

		session.abortCompaction()

		await expect(promise).rejects.toThrow("Compaction cancelled")
	})

	it("rejects when a compaction is already in progress", async () => {
		install()
		const session = new FakeSession()
		session._compactionAbortController = new AbortController()

		await expect(inlineSession(session).inlineCompact()).rejects.toThrow("Compaction already in progress")

		session._compactionAbortController = undefined
		session._autoCompactionAbortController = new AbortController()

		await expect(inlineSession(session).inlineCompact()).rejects.toThrow("Compaction already in progress")
	})

	it("rejects when the branch has an unpaired toolCall", async () => {
		install()
		const session = new FakeSession()
		session.branch = [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "t1" }] },
			},
		]

		await expect(inlineSession(session).inlineCompact({ force: true })).rejects.toThrow("tool call is in flight")
		expect(session.sessionManager.appendCompaction).not.toHaveBeenCalled()
		expect(session.summarizeCalls).toEqual([])
	})

	it("ignores unpaired toolCalls that predate the newest compaction entry", async () => {
		install()
		const session = new FakeSession()
		session.branch = [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "stale-orphan" }] },
			},
			{ type: "compaction", summary: "earlier summary" },
			{ type: "message", message: { role: "user", content: "hi" } },
		]

		await expect(inlineSession(session).inlineCompact({ force: true })).resolves.toMatchObject({
			summary: "summary",
		})
	})
})
