import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { BeforeAgentStartEvent, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { populateCliArgs } from "../../cli-args.js"
import { MEMORY_SAVED_STATUS_KEY, MEMORY_STATUS_KEY } from "../../components/status-line.js"
import { createAcpUIContext } from "../../modes/acp/acp-ui-context.js"
import { createCommandContext, createContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { adminDeleteFacts, adminListFacts, adminSearchFacts, runAdminCommand } from "./admin.js"
import { MEMORY_PRE_REQUEST_TIMEOUT_MS, TURN_RECALL_QUERY_MAX_CHARS } from "./config.js"
import { createMemoryExtension, type MemorySearcher, memoryEnabledNotice } from "./index.js"
import { MemoryPanel } from "./memory-panel.js"
import { getSessionMemoryOverride, setSessionMemoryOverride } from "./session-toggle.js"
import { createMemorySaveTool } from "./tools.js"

// The /memory command handler delegates to the admin core; the backend-
// touching functions are mocked so arg threading, panel mounting, and
// output routing are testable under Node without real stores.
// parseAdminArgs stays real — the handler routes on it.
vi.mock("./admin.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./admin.js")>()
	return {
		...actual,
		runAdminCommand: vi.fn(),
		adminListFacts: vi.fn(),
		adminSearchFacts: vi.fn(),
		adminDeleteFacts: vi.fn(),
	}
})

// Unit tests never hit the real gateway: the default gate resolution path
// reads the env, so tests that don't inject a decision dep must see
// "everything off". Gate-logic tests inject their own decision dep, which
// bypasses the env entirely.
vi.stubEnv("KIMCHI_MEMORY_DECISION_GATE", "off")

beforeEach(() => {
	vi.mocked(runAdminCommand).mockReset()
	vi.mocked(adminListFacts).mockReset()
	vi.mocked(adminSearchFacts).mockReset()
	vi.mocked(adminDeleteFacts).mockReset()
})

const BASE_PROMPT = "You are kimchi."

// Handler ctx: the shared mock factory (repo testing rule — no hand-rolled
// ctx mocks). The incremental-capture call reads getEntries() on every
// before_agent_start; the factory provides an empty one.
const fakeCtx = createContext()

function hits(...items: Array<{ memory: string; score: number }>): MemorySearcher {
	return { search: vi.fn(async () => items) }
}

// The drift recall runs detached from its turn start (the submit-latency
// fix) — settle its gate/search/delivery/refire before asserting on it.
// Positive outcomes poll (vi.waitFor) instead of draining a fixed number of
// macrotasks: a hop on the recall path that gains a real async boundary
// (retry backoff, a timer in the gate) would break any fixed count and let
// assertions run before the chain settles.
async function flushRecall(settled: () => void): Promise<void> {
	await vi.waitFor(settled, { interval: 10, timeout: 2_000 })
}

// Absence checks cannot poll — drain the pending chain with a few macrotask
// turns (each timer callback runs only after the microtask queue empties,
// and a timer scheduled during the first drain gets its own hop before the
// assertion runs), then assert that nothing fired.
async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Last recorded call for one status/widget key — the settle signal the recall chain leaves behind. */
function lastCallFor(calls: ReadonlyArray<readonly [string, ...unknown[]]>, key: string) {
	return calls.filter((call) => call[0] === key).at(-1)
}

function startEvent(prompt: string): BeforeAgentStartEvent {
	// upstream pi: before_agent_start is a discriminated union — the runtime
	// handler guards on messageType === "user", so the fixture must emit the
	// BeforeAgentStartUserEvent shape (systemPromptOptions is unused by the
	// handler; the double cast keeps the partial literal honest).
	return {
		type: "before_agent_start",
		messageType: "user",
		systemPrompt: BASE_PROMPT,
		systemPromptOptions: undefined,
		prompt,
		images: [],
	} as unknown as BeforeAgentStartEvent
}

async function setup(extension: (pi: ExtensionAPI) => void) {
	const { api, getHandler, sendMessage } = createExtensionApi()
	extension(api)
	const start = getHandler<BeforeAgentStartEvent, { systemPrompt?: string } | undefined>("before_agent_start")
	return { api, getHandler, sendMessage, start }
}

afterEach(() => {
	populateCliArgs([])
	vi.restoreAllMocks()
})

describe("memory extension", () => {
	it("registers the memory_search tool and capture handlers when enabled", () => {
		const { api, getRegisteredTool } = createExtensionApi()
		createMemoryExtension({ isEnabled: () => true, createSearcher: async () => hits() })(api)
		expect(api.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function))
		expect(api.on).toHaveBeenCalledWith("session_compact", expect.any(Function))
		expect(getRegisteredTool("memory_search")).toBeDefined()
	})

	it("registers nothing when disabled", () => {
		const { api } = createExtensionApi()
		createMemoryExtension({ isEnabled: () => false })(api)
		expect(api.on).not.toHaveBeenCalled()
		expect(vi.mocked(api.registerTool)).not.toHaveBeenCalled()
		expect(vi.mocked(api.registerCommand)).not.toHaveBeenCalled()
	})

	it("registers the /memory management command and routes its output", async () => {
		const admin = await import("./admin.js")
		const { api, getRegisteredCommand } = createExtensionApi()
		createMemoryExtension({ isEnabled: () => true, createSearcher: async () => hits() })(api)
		const command = getRegisteredCommand("memory")
		expect(command.description).toContain("Manage persistent memory")
		const ctx = createCommandContext()

		// Non-panel results take the text path: a short result notifies and
		// clears any stale view.
		vi.mocked(admin.runAdminCommand).mockResolvedValue({
			text: "single-line result",
			json: "{}",
			code: 0,
			useJson: false,
		})
		await command.handler("delete abc", ctx)
		expect(admin.runAdminCommand).toHaveBeenCalledWith(["delete", "abc"], expect.objectContaining({ cwd: ctx.cwd }))
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("memory-view", undefined)
		expect(ctx.ui.notify).toHaveBeenCalledWith("single-line result", "info")

		// Multi-line output renders as a read-only widget — never the editor.
		vi.mocked(admin.runAdminCommand).mockResolvedValue({
			text: "line 1\nline 2",
			json: "{}",
			code: 0,
			useJson: false,
		})
		await command.handler("", ctx)
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("memory-view", ["line 1", "line 2"])
		expect(ctx.ui.editor).not.toHaveBeenCalled()

		// Very long output is capped at the TUI's widget limit with a hint.
		const long = Array.from({ length: 40 }, (_, i) => `fact ${i}`).join("\n")
		vi.mocked(admin.runAdminCommand).mockResolvedValue({ text: long, json: "{}", code: 0, useJson: false })
		await command.handler("", ctx)
		const shown = vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)?.[1]
		if (!Array.isArray(shown)) throw new Error("expected widget lines")
		expect(shown).toHaveLength(10)
		expect(shown.at(-1)).toContain("30 more lines")

		// list opens the interactive panel instead of dumping text.
		vi.mocked(admin.adminListFacts).mockResolvedValue([
			{ id: "f1", memory: "the user's dog is named Fred", scopeId: "personal", createdAt: "2026-09-11" },
		])
		await command.handler("list", ctx)
		// /tmp (the mock cwd) is not a repository — the local default degrades
		// to personal-only.
		expect(admin.adminListFacts).toHaveBeenCalledWith({ kind: "local", scopeId: undefined })
		expect(ctx.ui.custom).toHaveBeenCalledTimes(1)
		// Mount the factory as the TUI would and inspect the resulting panel.
		const factory = vi.mocked(ctx.ui.custom).mock.calls[0]?.[0]
		const mounted = factory(
			{ requestRender: () => {}, terminal: { rows: 24 } } as never,
			{} as never,
			{} as never,
			vi.fn(),
		)
		if (!(mounted instanceof MemoryPanel)) throw new Error("expected a MemoryPanel")
		expect(mounted.render(80).join("\n")).toContain("Memory — 1 fact")
		expect(mounted.render(80).join("\n")).toContain("the user's dog is named Fred")

		// --json takes the text path instead of opening the panel.
		vi.mocked(admin.runAdminCommand).mockResolvedValue({
			text: "ignored",
			json: '{\n  "total": 0\n}',
			code: 0,
			useJson: true,
		})
		await command.handler("list --json", ctx)
		expect(admin.adminListFacts).toHaveBeenCalledTimes(1) // not called again for --json
		expect(ctx.ui.custom).toHaveBeenCalledTimes(1) // unchanged — no second panel
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("memory-view", ["{", '  "total": 0', "}"])

		// rpc mode (ACP): no panel — the text path renders through the UI
		// bridge (notify/setWidget), exactly like the overview.
		const rpcCtx = { ...createCommandContext(), mode: "rpc" as const }
		vi.mocked(admin.runAdminCommand).mockResolvedValue({
			text: "rpc line 1\nrpc line 2",
			json: "{}",
			code: 0,
			useJson: false,
		})
		await command.handler("list", rpcCtx)
		expect(admin.adminListFacts).toHaveBeenCalledTimes(1) // no second panel fetch
		expect(rpcCtx.ui.custom).not.toHaveBeenCalled()
		expect(rpcCtx.ui.setWidget).toHaveBeenCalledWith("memory-view", ["rpc line 1", "rpc line 2"])

		// A non-UI context (print mode) prints plainly to the console.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			const plainCtx = { ...createCommandContext(), mode: "rpc" as const, hasUI: false }
			vi.mocked(admin.runAdminCommand).mockResolvedValue({
				text: "plain output",
				json: "{}",
				code: 0,
				useJson: false,
			})
			await command.handler("list", plainCtx)
			expect(admin.adminListFacts).toHaveBeenCalledTimes(1) // panel routing requires the TUI
			expect(logSpy).toHaveBeenCalledWith("plain output")
		} finally {
			logSpy.mockRestore()
		}

		// search surfaces fetch failures as an error notification.
		vi.mocked(admin.adminSearchFacts).mockRejectedValue(new Error("no api key"))
		await command.handler("search dog", ctx)
		expect(ctx.ui.notify).toHaveBeenCalledWith("error: no api key", "error")
	})

	it("clears the /memory view when an agent turn resumes", async () => {
		const search = vi.fn(async () => [{ memory: "fact", score: 0.6 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		const ctx = createContext()
		await start(startEvent("turn 1"), ctx)
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("memory-view", undefined)
	})

	it("carries the digest from the very first start and keeps it byte-stable across turns", async () => {
		const { start } = await setup(
			createMemoryExtension({
				isEnabled: () => true,
				createSearcher: async () =>
					hits({ memory: "user prefers pnpm over npm", score: 0.7 }, { memory: "unrelated", score: 0.1 }),
			}),
		)
		const turn1 = await start(startEvent("set up the repo"), fakeCtx)
		expect(turn1?.systemPrompt).toContain("user prefers pnpm over npm")
		expect(turn1?.systemPrompt).not.toContain("unrelated")

		// Turns 2 and 3 must be byte-identical to turn 1 — the stable-prefix
		// cache contract (zero mid-session prompt changes attributable to memory).
		const turn2 = await start(startEvent("next turn"), fakeCtx)
		const turn3 = await start(startEvent("third"), fakeCtx)
		expect(turn2?.systemPrompt).toBe(turn1?.systemPrompt)
		expect(turn3?.systemPrompt).toBe(turn1?.systemPrompt)
	})

	it("an empty digest injects no facts — only the always-on notice (drift keeps re-evaluating)", async () => {
		const search = vi.fn(async () => [{ memory: "weak", score: 0.1 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		for (let turn = 0; turn < 3; turn++) {
			const result = await start(startEvent(`turn ${turn}`), fakeCtx)
			await flushRecall(() => expect(search).toHaveBeenCalledTimes(turn + 1))
			// The model must know capture is automatic even with no digest, and
			// where the user manages what is stored.
			expect(result?.systemPrompt).toContain("captured automatically")
			expect(result?.systemPrompt).toContain("/memory")
			expect(result?.systemPrompt).toContain("kimchi memory")
			expect(result?.systemPrompt).not.toContain("weak")
		}
		// Turn 1 (digest) + turns 2-3: nothing was delivered, so the gate sees
		// drift and retries retrieval — nothing new clears the bar, nothing lands.
		expect(search).toHaveBeenCalledTimes(3)
	})

	it("recomputes the digest after compaction, then goes stable again", async () => {
		const searcher = { search: vi.fn(async () => [{ memory: "post-compact fact", score: 0.6 }]) }
		const { start, getHandler } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => searcher }),
		)
		const compact = getHandler("session_compact")

		const first = await start(startEvent("turn 1"), fakeCtx)
		expect(first?.systemPrompt).toContain("post-compact fact")

		compact({ type: "session_compact" }, fakeCtx)
		const afterCompact = await start(startEvent("turn 2"), fakeCtx)
		expect(afterCompact?.systemPrompt).toContain("post-compact fact")

		// Turn 3 drift-retrieves ("turn 3" is uncovered against the reseeded
		// ledger) — search count: digest, post-compact recompute, drift recall.
		const later = await start(startEvent("turn 3"), fakeCtx)
		expect(later?.systemPrompt).toBe(afterCompact?.systemPrompt)
		await flushRecall(() => expect(searcher.search).toHaveBeenCalledTimes(3))
		expect(searcher.search).toHaveBeenCalledTimes(3)
	})

	it("degrades to no-memory when the store fails — logged once, session untouched", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const { start } = await setup(
				createMemoryExtension({
					isEnabled: () => true,
					createSearcher: async () => {
						throw new Error("store unavailable")
					},
				}),
			)
			for (let turn = 0; turn < 2; turn++) {
				const result = await start(startEvent(`turn ${turn}`), fakeCtx)
				expect(result?.systemPrompt).toContain("captured automatically")
			}
			expect(consoleError).toHaveBeenCalledTimes(1)
			expect(consoleError.mock.calls[0]?.[0]).toContain("[memory]")
		} finally {
			consoleError.mockRestore()
		}
	})

	it("degrades to no-memory when the digest search hangs — and retries the digest next turn", async () => {
		vi.useFakeTimers()
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			// Only the first search hangs; later calls resolve. A timeout must
			// NOT cache the failure: the next turn recomputes the digest.
			const search = vi.fn((query: string) => {
				if (search.mock.calls.length === 1) return new Promise<Array<{ memory?: string }>>(() => {})
				return Promise.resolve([{ memory: `fact for ${query.length}`, score: 0.7 }])
			})
			const { sendMessage, start } = await setup(
				createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
			)
			const pending = start(startEvent("turn 1"), fakeCtx)
			await vi.advanceTimersByTimeAsync(MEMORY_PRE_REQUEST_TIMEOUT_MS + 10)
			const result = await pending
			// Degraded to no facts — the notice is still present.
			expect(result?.systemPrompt).toContain("captured automatically")
			expect(result?.systemPrompt).not.toContain("fact for")
			expect(consoleError.mock.calls.some(([m]) => String(m).includes("timed out"))).toBe(true)
			// Retry: turn 2 recomputes the digest into the prefix (no recall —
			// the digest search already used this prompt).
			const turn2 = await start(startEvent("turn 2"), fakeCtx)
			expect(turn2?.systemPrompt).toContain("fact for")
			expect(search).toHaveBeenCalledTimes(2)
			// The recall valve is untouched: turn 3's drift fires and delivers.
			await start(startEvent("turn 3 - fresh territory"), fakeCtx)
			await vi.advanceTimersByTimeAsync(MEMORY_PRE_REQUEST_TIMEOUT_MS)
			expect(search).toHaveBeenCalledTimes(3)
			expect(sendMessage).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
			consoleError.mockRestore()
		}
	})

	it("the recall gate is bounded by the pre-request timeout — it falls open to searching", async () => {
		vi.useFakeTimers()
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			// The drift search must surface something NEW — the digest already
			// delivered its own fact, and recall delivery is dedupe-gated.
			let call = 0
			const indexedSearch = vi.fn(async () => {
				call += 1
				return [{ memory: call === 1 ? "digest fact" : "drift fact", score: 0.7 }]
			})
			// A gateway that accepts the connection and never answers.
			const hung = async () => new Promise<Response>(() => {})
			const { sendMessage, start } = await setup(
				createMemoryExtension({
					isEnabled: () => true,
					createSearcher: async () => ({ search: indexedSearch }),
					decision: () => ({
						gate: { endpoint: "https://gw.test/typesafe/v1/systemone", apiKey: "k", fetchImpl: hung, maxRetries: 0 },
						enabled: new Set(["recall"]),
					}),
				}),
			)
			await start(startEvent("turn 1"), fakeCtx)
			await start(startEvent("turn 2 - fresh territory"), fakeCtx)
			await vi.advanceTimersByTimeAsync(MEMORY_PRE_REQUEST_TIMEOUT_MS + 10)
			// The gate timed out at the pre-request bound, logged it, and the
			// pre-gate behavior took over — the drift search still ran and
			// delivered.
			expect(
				consoleError.mock.calls.some(([m]) => String(m).includes("recall gating") && String(m).includes("timed out")),
			).toBe(true)
			expect(indexedSearch).toHaveBeenCalledTimes(2)
			expect(sendMessage).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
			consoleError.mockRestore()
		}
	})

	it("a hung searcher factory degrades per turn and never wedges the session — the next turn retries", async () => {
		vi.useFakeTimers()
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			let createCalls = 0
			const search = vi.fn(async () => [{ memory: "late-blooming fact", score: 0.8 }])
			const { sendMessage, start } = await setup(
				createMemoryExtension({
					isEnabled: () => true,
					createSearcher: () => {
						createCalls += 1
						// First factory call never settles (wedged backend); the
						// second one succeeds.
						return createCalls === 1 ? new Promise(() => {}) : Promise.resolve({ search })
					},
				}),
			)
			const pending = start(startEvent("turn 1"), fakeCtx)
			await vi.advanceTimersByTimeAsync(MEMORY_PRE_REQUEST_TIMEOUT_MS + 10)
			const result = await pending
			// Bounded: the turn degrades to the bare notice instead of hanging.
			expect(result?.systemPrompt).toContain("captured automatically")
			expect(result?.systemPrompt).not.toContain("late-blooming")
			expect(consoleError.mock.calls.some(([m]) => String(m).includes("timed out"))).toBe(true)
			// The wedged factory call did not wedge the session: turn 2 retries
			// with a FRESH factory call and the digest lands in the prefix.
			const turn2 = await start(startEvent("turn 2"), fakeCtx)
			expect(createCalls).toBe(2)
			expect(turn2?.systemPrompt).toContain("late-blooming fact")
			expect(sendMessage).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
			consoleError.mockRestore()
		}
	})

	it("a mid-recall toggle-off suppresses delivery and ledger mutation — the valve still releases", async () => {
		let releaseSearch: (() => void) | undefined
		const search = vi
			.fn()
			.mockResolvedValueOnce([{ memory: "digest fact", score: 0.7 }])
			.mockImplementationOnce(
				() =>
					new Promise<Array<{ memory: string; score: number }>>((resolve) => {
						releaseSearch = () => resolve([{ memory: "suppressed fact", score: 0.7 }])
					}),
			)
			.mockResolvedValueOnce([{ memory: "post-reenable fact", score: 0.7 }])
			.mockResolvedValue([{ memory: "fresh delivered fact", score: 0.7 }])
		const { sendMessage, start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("turn 1"), fakeCtx)
		await start(startEvent("turn 2 - fresh territory"), fakeCtx)
		await flushRecall(() => expect(search).toHaveBeenCalledTimes(2))
		// The drift recall is in flight (its search unreleased).
		expect(search).toHaveBeenCalledTimes(2)
		// Flip the toggle OFF while it is pending, then let the search resolve.
		setSessionMemoryOverride(fakeCtx.sessionManager, false)
		releaseSearch?.()
		await settle()
		// The mid-recall guard: no delivery, no ledger mutation.
		expect(sendMessage).not.toHaveBeenCalled()
		// While disabled: no memory contribution at all.
		const off = await start(startEvent("turn 3"), fakeCtx)
		expect(off).toBeUndefined()
		// Re-enable: the flip resets and recomputes the digest (search 3), and
		// the released valve lets a later drift deliver (search 4 + steer).
		setSessionMemoryOverride(fakeCtx.sessionManager, true)
		const back = await start(startEvent("turn 4"), fakeCtx)
		expect(back?.systemPrompt).toContain("post-reenable fact")
		await start(startEvent("turn 5 - brand new territory"), fakeCtx)
		await flushRecall(() => {
			expect(search).toHaveBeenCalledTimes(4)
			expect(sendMessage).toHaveBeenCalledTimes(1)
		})
		const [message] = sendMessage.mock.calls[0] as [{ content: Array<{ type: string; text: string }> }, ...unknown[]]
		expect(message.content[0]?.text).toContain("fresh delivered fact")
	})

	it("honors the --memory CLI flag via getParsedCliArgs", async () => {
		populateCliArgs(["--memory"])
		const searcher = { search: vi.fn(async () => [{ memory: "flag fact", score: 0.6 }]) }
		const { start } = await setup(createMemoryExtension({ createSearcher: async () => searcher }))
		const result = await start(startEvent("turn"), fakeCtx)
		expect(result?.systemPrompt).toContain("flag fact")
		populateCliArgs([])
	})

	it("steers new facts on topic drift, once — deduped across turns", async () => {
		const search = vi
			.fn()
			.mockResolvedValueOnce([{ memory: "user prefers pnpm over npm", score: 0.7 }])
			.mockResolvedValueOnce([
				{ memory: "user prefers pnpm over npm", score: 0.7 },
				{ memory: "user bakes chocolate cakes on weekends", score: 0.5 },
			])
			.mockResolvedValueOnce([{ memory: "user bakes chocolate cakes on weekends", score: 0.5 }])
		const { sendMessage, start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		const turn1 = await start(startEvent("set up the repo"), fakeCtx)
		expect(turn1?.systemPrompt).toContain("user prefers pnpm over npm")

		// Topic drift: the new prompt is uncovered territory — a steer with
		// ONLY the new fact goes out (hidden, deliverAs steer).
		const turn2 = await start(startEvent("what do I bake?"), fakeCtx)
		await flushRecall(() => expect(sendMessage).toHaveBeenCalledTimes(1))
		expect(turn2?.systemPrompt).toBe(turn1?.systemPrompt)
		expect(sendMessage).toHaveBeenCalledTimes(1)
		const [message, options] = sendMessage.mock.calls[0] as [
			{ customType: string; content: Array<{ type: string; text: string }>; display: boolean },
			{ deliverAs: string; triggerTurn?: boolean },
		]
		expect(message.customType).toBe("memory-recall")
		expect(message.display).toBe(false)
		expect(options.deliverAs).toBe("steer")
		expect(message.content[0]?.text).toContain("user bakes chocolate cakes")
		expect(message.content[0]?.text).not.toContain("pnpm")
		expect(options.triggerTurn).toBe(false)

		// Same territory again: the fact is already delivered — no second steer.
		await start(startEvent("more about baking?"), fakeCtx)
		await settle()
		expect(sendMessage).toHaveBeenCalledTimes(1)
	})

	it("bounds the drift-recall embedding query to the prompt plus the response tail", async () => {
		const longResponse = `HEAD_MARKER${"x".repeat(2000)}TAIL_MARKER`
		// lastAssistantText reads the entry structurally (role + text content)
		// only; a full AssistantMessage carries provider metadata the reader
		// never touches — same partial-literal style as startEvent above.
		const assistantEntry = {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: Date.now(),
			message: { role: "assistant", content: [{ type: "text", text: longResponse }] },
		} as unknown as SessionEntry
		const ctx = createContext({
			sessionManager: { getEntries: () => [assistantEntry] },
		})
		const search = vi.fn(async (query: string) => [{ memory: `fact for ${query.length}`, score: 0.6 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("first prompt"), fakeCtx)
		await start(startEvent("second prompt"), ctx)
		await flushRecall(() => expect(search).toHaveBeenCalledTimes(2))
		// Turn 1 embedded the prompt alone; turn 2's drift query carries the
		// prompt plus only the TAIL of the last assistant response — the
		// 2000-char body stays out of the embedding payload.
		const driftQuery = search.mock.calls[1]?.[0]
		expect(typeof driftQuery).toBe("string")
		expect(driftQuery).toContain("second prompt")
		expect(driftQuery).toContain("TAIL_MARKER")
		expect(driftQuery).not.toContain("HEAD_MARKER")
		expect(driftQuery?.length).toBeLessThanOrEqual(TURN_RECALL_QUERY_MAX_CHARS)
	})

	it("a long prompt cannot push the response tail out of the drift query", async () => {
		const longResponse = `HEAD_MARKER${"x".repeat(2000)}TAIL_MARKER`
		const assistantEntry = {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: Date.now(),
			message: { role: "assistant", content: [{ type: "text", text: longResponse }] },
		} as unknown as SessionEntry
		const ctx = createContext({
			sessionManager: { getEntries: () => [assistantEntry] },
		})
		const search = vi.fn(async (query: string) => [{ memory: `fact for ${query.length}`, score: 0.6 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("first prompt"), fakeCtx)
		await settle()
		// A prompt longer than the total cap (e.g. a stack trace or spec
		// paste) — the old post-join slice let it push the response tail out
		// entirely; each half is capped separately now, so both contribute.
		const longPrompt = `PROMPT_HEAD${"y".repeat(TURN_RECALL_QUERY_MAX_CHARS)}PROMPT_TAIL`
		await start(startEvent(longPrompt), ctx)
		await flushRecall(() => expect(search).toHaveBeenCalledTimes(2))
		const driftQuery = search.mock.calls[1]?.[0]
		expect(typeof driftQuery).toBe("string")
		expect(driftQuery).toContain("PROMPT_HEAD")
		expect(driftQuery).not.toContain("PROMPT_TAIL")
		expect(driftQuery).toContain("TAIL_MARKER")
		expect(driftQuery).not.toContain("HEAD_MARKER")
		expect(driftQuery?.length).toBeLessThanOrEqual(TURN_RECALL_QUERY_MAX_CHARS)
	})

	it("shows the recall indicator while retrieval runs and clears it after", async () => {
		const ctx = createContext()
		const setDuringSearch: Array<unknown> = []
		const search = vi.fn(async () => {
			// What was on screen while the search was in flight?
			setDuringSearch.push(vi.mocked(ctx.ui.setWidget).mock.calls.at(-1))
			return [{ memory: "user prefers pnpm over npm", score: 0.7 }]
		})
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("set up the repo"), ctx)
		// The indicator was on screen during the retrieval, and the turn
		// ended with it cleared — nothing left behind.
		expect(setDuringSearch).toEqual([["memory-recall", ["› set up the repo", "Recalling memory…"]]])
		const recallCalls = vi.mocked(ctx.ui.setWidget).mock.calls.filter((call) => call[0] === "memory-recall")
		expect(recallCalls.at(-1)).toEqual(["memory-recall", undefined])
	})

	it("truncates a long prompt to one line in the recall widget", async () => {
		const ctx = createContext()
		const seen: Array<unknown> = []
		const search = vi.fn(async () => {
			seen.push(vi.mocked(ctx.ui.setWidget).mock.calls.at(-1))
			return [{ memory: "user prefers pnpm over npm", score: 0.7 }]
		})
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent(`edge ${"x".repeat(200)}`), ctx)
		// One capped line with an ellipsis — never the full 200-char payload.
		expect(seen).toEqual([["memory-recall", [`› edge ${"x".repeat(114)}…`, "Recalling memory…"]]])
	})

	it("shows only the first line of a multi-line prompt in the recall widget", async () => {
		const ctx = createContext()
		const seen: Array<unknown> = []
		const search = vi.fn(async () => {
			seen.push(vi.mocked(ctx.ui.setWidget).mock.calls.at(-1))
			return [{ memory: "user prefers pnpm over npm", score: 0.7 }]
		})
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("first line of a paste\nsecond line stays hidden"), ctx)
		expect(seen).toEqual([["memory-recall", ["› first line of a paste", "Recalling memory…"]]])
	})

	it("falls back to the bare progress line for a whitespace-only prompt", async () => {
		const ctx = createContext()
		const seen: Array<unknown> = []
		const search = vi.fn(async () => {
			seen.push(vi.mocked(ctx.ui.setWidget).mock.calls.at(-1))
			return [{ memory: "user prefers pnpm over npm", score: 0.7 }]
		})
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("   "), ctx)
		expect(seen).toEqual([["memory-recall", ["Recalling memory…"]]])
	})

	it("sets the memory status segment to the delivered fact count", async () => {
		const ctx = createContext()
		const search = vi.fn(async () => [{ memory: "user prefers pnpm over npm", score: 0.7 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("set up the repo"), ctx)
		// The status-line segment mirrors the delivery ledger: 1 fact in context.
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_STATUS_KEY, "1"])
	})

	it("updates the memory status as turn recall delivers more facts", async () => {
		let n = 0
		const search = vi.fn(async () => [{ memory: `distinct fact number ${++n}`, score: 0.6 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		const ctx = createContext()
		await start(startEvent("drift topic 1"), ctx)
		await start(startEvent("drift topic 2"), ctx)
		// Recall delivery is detached from the turn start — settle it before
		// asserting on the status segment.
		await flushRecall(() =>
			expect(lastCallFor(vi.mocked(ctx.ui.setStatus).mock.calls, MEMORY_STATUS_KEY)).toEqual([MEMORY_STATUS_KEY, "2"]),
		)
		const calls = vi.mocked(ctx.ui.setStatus).mock.calls.filter((call) => call[0] === MEMORY_STATUS_KEY)
		expect(calls).toContainEqual([MEMORY_STATUS_KEY, "1"])
	})

	it("clears the memory status when the session toggle disables memory", async () => {
		const search = vi.fn(async () => [{ memory: "flag fact", score: 0.7 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		const ctx = createContext()
		await start(startEvent("turn 1"), ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_STATUS_KEY, "1"])
		setSessionMemoryOverride(ctx.sessionManager, false)
		await start(startEvent("turn 2"), ctx)
		// Both halves clear — the flip emptied the ledger and the saved watermark.
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_STATUS_KEY, undefined])
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_SAVED_STATUS_KEY, undefined])
	})

	it("clears the memory status when compaction resets the delivery ledger", async () => {
		const search = vi.fn(async () => [{ memory: "user prefers pnpm over npm", score: 0.7 }])
		const { start, getHandler } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		const ctx = createContext()
		await start(startEvent("set up the repo"), ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_STATUS_KEY, "1"])
		getHandler("session_compact")({ type: "session_compact" }, ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls.at(-1)).toEqual([MEMORY_STATUS_KEY, undefined])
	})

	it("never sets the memory status without a UI", async () => {
		const ctx = createContext({ hasUI: false })
		const search = vi.fn(async () => [{ memory: "user prefers pnpm over npm", score: 0.7 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("set up the repo"), ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls.every((call) => call[0] !== MEMORY_STATUS_KEY)).toBe(true)
		expect(vi.mocked(ctx.ui.notify).mock.calls.every((call) => !String(call[0]).startsWith("Recalled"))).toBe(true)
	})

	it("announces the first delivery once, then only updates the segment", async () => {
		let n = 0
		const search = vi.fn(async () => [{ memory: `distinct fact number ${++n}`, score: 0.6 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		const ctx = createContext()
		await start(startEvent("drift topic 1"), ctx)
		await start(startEvent("drift topic 2"), ctx)
		await flushRecall(() =>
			expect(lastCallFor(vi.mocked(ctx.ui.setStatus).mock.calls, MEMORY_STATUS_KEY)).toEqual([MEMORY_STATUS_KEY, "2"]),
		)
		// The first delivery announced itself — exactly once, pluralized.
		expect(vi.mocked(ctx.ui.notify).mock.calls.filter((call) => String(call[0]).startsWith("Recalled"))).toEqual([
			["Recalled 1 memory", "info"],
		])
		// The later recall grew the segment silently — no second announce.
		const statusCalls = vi.mocked(ctx.ui.setStatus).mock.calls.filter((call) => call[0] === MEMORY_STATUS_KEY)
		expect(statusCalls.at(-1)).toEqual([MEMORY_STATUS_KEY, "2"])
	})

	it("pluralizes the first-recall notification for multi-fact digests", async () => {
		const ctx = createContext()
		const search = vi.fn(async () => [
			{ memory: "user prefers pnpm over npm", score: 0.7 },
			{ memory: "the user lives in Lisbon", score: 0.6 },
		])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("set up the repo"), ctx)
		expect(vi.mocked(ctx.ui.notify).mock.calls).toContainEqual(["Recalled 2 memories", "info"])
	})

	it("clears the recall indicator even when retrieval fails", async () => {
		const ctx = createContext()
		const search = vi
			.fn()
			.mockResolvedValueOnce([{ memory: "user prefers pnpm over npm", score: 0.7 }])
			.mockRejectedValueOnce(new Error("gateway down"))
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("set up the repo"), ctx)
		// Only the detached recall's widget calls count from here — turn 1's
		// digest indicator must not satisfy the "was set" assertion.
		const callsBeforeTurn2 = vi.mocked(ctx.ui.setWidget).mock.calls.length
		// Turn 2 drifts into uncovered territory and the search throws — the
		// finally guard must still clear the indicator.
		await start(startEvent("what do I bake?"), ctx)
		await flushRecall(() =>
			expect(lastCallFor(vi.mocked(ctx.ui.setWidget).mock.calls.slice(callsBeforeTurn2), "memory-recall")).toEqual([
				"memory-recall",
				undefined,
			]),
		)
		const recallCalls = vi
			.mocked(ctx.ui.setWidget)
			.mock.calls.slice(callsBeforeTurn2)
			.filter((call) => call[0] === "memory-recall")
		expect(recallCalls.some((call) => call[1] !== undefined)).toBe(true)
	})

	it("never touches the widget API without a UI (headless / ACP)", async () => {
		const ctx = createContext({ hasUI: false })
		const search = vi.fn(async () => [{ memory: "user prefers pnpm over npm", score: 0.7 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("set up the repo"), ctx)
		// Retrieval still ran — the indicator is purely a TUI affordance.
		expect(search).toHaveBeenCalled()
		expect(vi.mocked(ctx.ui.setWidget).mock.calls.every((call) => call[0] !== "memory-recall")).toBe(true)
	})

	it("gate skips retrieval when the conversation stays covered", async () => {
		const search = vi.fn(async () => [{ memory: "user prefers pnpm over npm", score: 0.7 }])
		const { sendMessage, start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("set up the repo with pnpm"), fakeCtx)
		// Follow-up inside delivered territory: covered — no extra retrieval.
		const covered = await start(startEvent("pnpm install"), fakeCtx)
		expect(covered?.systemPrompt).toContain("pnpm")
		expect(search).toHaveBeenCalledTimes(1)
		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("recalls on every drifted turn — no per-session evaluation cap", async () => {
		let n = 0
		const search = vi.fn(async () => [{ memory: `distinct fact number ${++n}`, score: 0.6 }])
		const { sendMessage, start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		for (let turn = 0; turn < 8; turn++) {
			await start(startEvent(`drift topic ${turn}`), fakeCtx)
			await flushRecall(() => expect(search).toHaveBeenCalledTimes(turn + 1))
		}
		// Turn 1 (digest) + one drift retrieval per follow-up turn — every user
		// message is fresh signal, so recall keeps running for the whole session.
		expect(search).toHaveBeenCalledTimes(8)
		expect(sendMessage).toHaveBeenCalledTimes(7)
	})

	it("the drift recall runs detached — the turn never waits on retrieval", async () => {
		let releaseSearch: (() => void) | undefined
		const search = vi
			.fn()
			.mockResolvedValueOnce([{ memory: "seed fact", score: 0.6 }])
			.mockImplementationOnce(
				() =>
					new Promise<Array<{ memory: string; score: number }>>((resolve) => {
						releaseSearch = () => resolve([{ memory: "late fact", score: 0.6 }])
					}),
			)
		const { sendMessage, start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("turn 1"), fakeCtx)
		const turn2 = await start(startEvent("turn 2 - fresh territory"), fakeCtx)
		await flushRecall(() => expect(search).toHaveBeenCalledTimes(2))
		// The handler returned (system prompt intact) with the drift search
		// still pending — nothing between Enter and the turn's request.
		expect(turn2?.systemPrompt).toContain("seed fact")
		expect(sendMessage).not.toHaveBeenCalled()
		releaseSearch?.()
		await flushRecall(() => expect(sendMessage).toHaveBeenCalledTimes(1))
		const call = sendMessage.mock.calls[0]
		expect(call?.[0].customType).toBe("memory-recall")
		expect(call?.[1]?.triggerTurn).toBe(false)
	})

	it("a drift skipped while a recall is in flight coalesces and refires on settle", async () => {
		let releaseSearch: (() => void) | undefined
		const search = vi
			.fn()
			.mockResolvedValueOnce([{ memory: "seed fact", score: 0.6 }])
			.mockImplementation(
				() =>
					new Promise<Array<{ memory: string; score: number }>>((resolve) => {
						releaseSearch = () => resolve([{ memory: "in-flight fact", score: 0.6 }])
					}),
			)
		const { sendMessage, start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("turn 1"), fakeCtx)
		await start(startEvent("turn 2 - fresh territory"), fakeCtx)
		await flushRecall(() => expect(search).toHaveBeenCalledTimes(2))
		// Turn 3 drifts while turn 2's recall is still pending — no stacked
		// search, but the skipped drift is queued, not dropped.
		await start(startEvent("turn 3 - more fresh territory"), fakeCtx)
		expect(search).toHaveBeenCalledTimes(2)
		releaseSearch?.()
		await flushRecall(() => {
			expect(sendMessage).toHaveBeenCalledTimes(1)
			expect(search).toHaveBeenCalledTimes(3)
		})
		// Settle → turn-2 delivery went out, and the coalesced turn-3 drift
		// fired its OWN search (its prompt, which the earlier query never saw).
		expect(String(search.mock.calls[2]?.[0])).toContain("turn 3 - more fresh territory")
		// Release the coalesced recall too — the valve opens again, and turn
		// 4's drift fires its own recall.
		releaseSearch?.()
		await settle()
		expect(sendMessage).toHaveBeenCalledTimes(1)
		await start(startEvent("turn 4 - yet more territory"), fakeCtx)
		await flushRecall(() => expect(search).toHaveBeenCalledTimes(4))
	})

	it("compaction during a pending recall doesn't break delivery", async () => {
		let releaseSearch: (() => void) | undefined
		const search = vi
			.fn()
			.mockResolvedValueOnce([{ memory: "seed fact", score: 0.6 }])
			.mockImplementationOnce(
				() =>
					new Promise<Array<{ memory: string; score: number }>>((resolve) => {
						releaseSearch = () => resolve([{ memory: "post-compact recall fact", score: 0.6 }])
					}),
			)
			.mockResolvedValue([{ memory: "recomputed fact", score: 0.6 }])
		const { sendMessage, start, getHandler } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		const compact = getHandler("session_compact")
		await start(startEvent("turn 1"), fakeCtx)
		await start(startEvent("turn 2 - fresh territory"), fakeCtx)
		await flushRecall(() => expect(search).toHaveBeenCalledTimes(2))
		compact({ type: "session_compact" }, fakeCtx)
		releaseSearch?.()
		await flushRecall(() => expect(sendMessage).toHaveBeenCalledTimes(1))

		// Post-interleaving state: the reset is respected — turn 3 recomputes
		// the digest against the post-compaction store (a fresh search), the
		// in-flight valve is released, and a later drifted turn fires recall
		// again.
		const turn3 = await start(startEvent("turn 3"), fakeCtx)
		expect(turn3?.systemPrompt).toContain("recomputed fact")
		await start(startEvent("turn 4 - fresh territory again"), fakeCtx)
		await flushRecall(() => expect(search).toHaveBeenCalledTimes(4))
	})

	it("the session toggle gates memory: disabled drops it, re-enable recomputes", async () => {
		const search = vi.fn(async () => [{ memory: "flag fact", score: 0.7 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		const ctx = createContext()
		const on = await start(startEvent("turn 1"), ctx)
		expect(on?.systemPrompt).toContain("flag fact")

		// Disabled through the shared toggle — exactly what the ACP
		// set_memory_enabled ext-method writes: no digest, no notice, no
		// recall, no further retrieval.
		setSessionMemoryOverride(ctx.sessionManager, false)
		const off = await start(startEvent("turn 2"), ctx)
		expect(off).toBeUndefined()
		expect(search).toHaveBeenCalledTimes(1)

		// Re-enabled: flip detection reset the digest — the next start
		// recomputes instead of replaying the stale prefix.
		setSessionMemoryOverride(ctx.sessionManager, true)
		const back = await start(startEvent("turn 3"), ctx)
		expect(back?.systemPrompt).toContain("flag fact")
		expect(search).toHaveBeenCalledTimes(2)
	})

	it("the session toggle is scoped per session", async () => {
		// Two runtimes — one per session, matching how pi binds extensions
		// (a fresh factory invocation per session runtime).
		const makeExtension = () =>
			createMemoryExtension({
				isEnabled: () => true,
				createSearcher: async () => ({ search: vi.fn(async () => [{ memory: "shared fact", score: 0.7 }]) }),
			})
		const a = await setup(makeExtension())
		const b = await setup(makeExtension())
		const ctxA = createContext()
		const ctxB = createContext()
		await a.start(startEvent("a 1"), ctxA)
		setSessionMemoryOverride(ctxA.sessionManager, false)
		expect(await a.start(startEvent("a 2"), ctxA)).toBeUndefined()
		// b's session is untouched — a fresh session starts active.
		const on = await b.start(startEvent("b 1"), ctxB)
		expect(on?.systemPrompt).toContain("shared fact")
	})

	it("the /memory command wires a session-scoped memoryState handle", async () => {
		const admin = await import("./admin.js")
		const { api, getRegisteredCommand } = createExtensionApi()
		createMemoryExtension({ isEnabled: () => true, createSearcher: async () => hits() })(api)
		const command = getRegisteredCommand("memory")
		const ctx = createCommandContext()
		vi.mocked(admin.runAdminCommand).mockResolvedValue({ text: "ok", json: "{}", code: 0, useJson: false })

		await command.handler("disable", ctx)
		const passed = vi.mocked(admin.runAdminCommand).mock.calls[0]?.[1]
		const handle = passed?.memoryState
		if (!handle) throw new Error("expected the handler to pass a memoryState handle")
		// The handle reads and writes the shared toggle keyed by the SAME
		// sessionManager the before_agent_start handler captures — so a flip
		// from the command affects the next agent start.
		handle.setSession(false)
		expect(getSessionMemoryOverride(ctx.sessionManager)).toBe(false)
		expect(handle.read()).toBe(false)
		handle.setSession(true)
		expect(getSessionMemoryOverride(ctx.sessionManager)).toBe(true)
		expect(handle.read()).toBe(true)
	})

	it("memory_search reports the disabled state instead of a misleading miss", async () => {
		const search = vi.fn(async () => [{ memory: "fact", score: 0.7 }])
		const { api, getHandler, getRegisteredTool } = createExtensionApi()
		createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) })(api)
		const start = getHandler<BeforeAgentStartEvent, { systemPrompt?: string } | undefined>("before_agent_start")
		const ctx = createToolContext()
		await start(startEvent("turn 1"), ctx)

		setSessionMemoryOverride(ctx.sessionManager, false)
		const tool = getRegisteredTool("memory_search")
		const result = (await tool.execute("t1", { query: "anything" }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text: string }>
		}
		expect(result.content[0]?.text).toContain("disabled")
		expect(result.content[0]?.text).toContain("/memory enable")
		// Only the turn-1 digest ran — the tool did not search.
		expect(search).toHaveBeenCalledTimes(1)
	})

	it("the /memory command's toggle gates the very next agent start (identity seam)", async () => {
		const admin = await import("./admin.js")
		// Route the command through the REAL admin core for this test — the
		// file-wide runAdminCommand mock would otherwise swallow the set-enabled
		// execution, and the point is the full path: command → handle → shared
		// toggle → runtime read.
		const real = await vi.importActual<typeof import("./admin.js")>("./admin.js")
		vi.mocked(admin.runAdminCommand).mockImplementation(real.runAdminCommand)
		try {
			const search = vi.fn(async () => [{ memory: "fact", score: 0.7 }])
			const { api, getHandler, getRegisteredCommand } = createExtensionApi()
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) })(api)
			const start = getHandler<BeforeAgentStartEvent, { systemPrompt?: string } | undefined>("before_agent_start")
			const command = getRegisteredCommand("memory")
			// ONE context object across both surfaces — the WeakMap key must be
			// the same sessionManager instance for the command's write and the
			// runtime's read (the session-toggle module's documented identity
			// assumption).
			const ctx = createCommandContext()

			const on = await start(startEvent("turn 1"), ctx)
			expect(on?.systemPrompt).toContain("fact")

			await command.handler("disable", ctx)
			expect(await start(startEvent("turn 2"), ctx)).toBeUndefined()

			await command.handler("enable", ctx)
			const back = await start(startEvent("turn 3"), ctx)
			expect(back?.systemPrompt).toContain("fact")
		} finally {
			// Drop the real-implementation bridge so later tests keep the
			// file-wide mock semantics.
			vi.mocked(admin.runAdminCommand).mockReset()
		}
	})
})

// Digest selection (E3/E6/E8): the decision model selects among the
// retrieved candidates; failures fall back to the threshold rule.
describe("memory extension — digest selection gate", () => {
	/** Extract the judged fact text from the valuation/digest question body. */
	function parseCandidate(instructions: string): string {
		return instructions.split('" — ')[0]?.split('"')[1] ?? ""
	}

	function selectorFetchImpl(injectTexts: string[]): typeof fetch {
		const fetchImpl: typeof fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { questions: Record<string, { instructions: string }> }
			const answers = Object.fromEntries(
				Object.entries(body.questions).map(([key, q]) => {
					const inject = injectTexts.includes(parseCandidate(q.instructions))
					return [
						key,
						{
							type: "choice",
							choice: inject ? "inject" : "skip",
							probabilities: { inject: inject ? 0.95 : 0.05, skip: inject ? 0.05 : 0.95 },
							confidence: 0.9,
						},
					]
				}),
			)
			return new Response(JSON.stringify({ answers, usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200 })
		}
		return fetchImpl
	}

	const searchable = () => [
		{ memory: "retire the gateway md5 greplier", score: 0.92 }, // rank-1 echo of the prompt
		{ memory: "the user's dog is named Freya", score: 0.71 },
		{ memory: "the user keeps herbs on the kitchen counter", score: 0.66 },
	]

	it("the selector drops the rank-1 echo and keeps the needle", async () => {
		const decisionFetch = selectorFetchImpl(["the user's dog is named Freya"])
		const { start } = await setup(
			createMemoryExtension({
				isEnabled: () => true,
				createSearcher: async () => ({ search: vi.fn(async () => searchable()) }),
				decision: () => ({
					gate: { endpoint: "https://gw.test/typesafe/v1/systemone", apiKey: "k", fetchImpl: decisionFetch },
					enabled: new Set(["digest"]),
				}),
			}),
		)
		const turn1 = await start(startEvent("how do I retire the gateway md5 greplier?"), fakeCtx)
		expect(turn1?.systemPrompt).toContain("the user's dog is named Freya")
		expect(turn1?.systemPrompt).not.toContain("greplier")
		expect(turn1?.systemPrompt).not.toContain("kitchen counter")
	})

	it("a selector failure falls back to the threshold rule for this digest", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const down = async () => new Response(JSON.stringify({ error: "quota" }), { status: 401 })
			const { start } = await setup(
				createMemoryExtension({
					isEnabled: () => true,
					createSearcher: async () => ({ search: vi.fn(async () => searchable()) }),
					decision: () => ({
						gate: {
							endpoint: "https://gw.test/typesafe/v1/systemone",
							apiKey: "k",
							fetchImpl: down,
							maxRetries: 0,
						},
						enabled: new Set(["digest"]),
					}),
				}),
			)
			const turn1 = await start(startEvent("memory check"), fakeCtx)
			// Threshold rule keeps all three (all above 0.2) — pre-gate behavior.
			expect(turn1?.systemPrompt).toContain("greplier")
			expect(turn1?.systemPrompt).toContain("Freya")
			expect(consoleError.mock.calls.some((call) => String(call[0]).includes("digest selection failed"))).toBe(true)
		} finally {
			consoleError.mockRestore()
		}
	})

	it("the digest floor widens the search to floor+1 (topK threads through) and selection runs above the floor", async () => {
		process.env.KIMCHI_MEMORY_DIGEST_SELECTION_MIN_CANDIDATES = "1"
		const decisionFetch = selectorFetchImpl(["the user's dog is named Freya"])
		const searchCalls: Array<number | undefined> = []
		const searcher = {
			search: vi.fn(async (_q: string, topK?: number) => {
				searchCalls.push(topK)
				return searchable()
			}),
		}
		const { start } = await setup(
			createMemoryExtension({
				isEnabled: () => true,
				createSearcher: async () => searcher,
				decision: () => ({
					gate: { endpoint: "https://gw.test/typesafe/v1/systemone", apiKey: "k", fetchImpl: decisionFetch },
					enabled: new Set(["digest"]),
				}),
			}),
		)
		const turn1 = await start(startEvent("digest floor pin"), fakeCtx)
		// 3 candidates strictly exceed the floor (1): the selection call ran.
		expect(turn1?.systemPrompt).toContain("the user's dog is named Freya")
		expect(turn1?.systemPrompt).not.toContain("greplier")
		// Searched with the widened cap, not the store default (8) nor floor itself.
		expect(searchCalls[0]).toBe(2)
		delete process.env.KIMCHI_MEMORY_DIGEST_SELECTION_MIN_CANDIDATES
	})

	it("at/under the floor the selector never runs (small stores keep recall)", async () => {
		process.env.KIMCHI_MEMORY_DIGEST_SELECTION_MIN_CANDIDATES = "3"
		const decisionFetch = vi.fn(async () => {
			throw new Error("must not be called")
		})
		const searchCalls: Array<number | undefined> = []
		const { start } = await setup(
			createMemoryExtension({
				isEnabled: () => true,
				createSearcher: async () => ({
					search: vi.fn(async (_q: string, topK?: number) => {
						searchCalls.push(topK)
						return searchable()
					}),
				}),
				decision: () => ({
					gate: { endpoint: "https://gw.test/typesafe/v1/systemone", apiKey: "k", fetchImpl: decisionFetch },
					enabled: new Set(["digest"]),
				}),
			}),
		)
		const turn1 = await start(startEvent("digest floor pin"), fakeCtx)
		// 3 candidates == floor 3: threshold rule keeps all.
		expect(turn1?.systemPrompt).toContain("greplier")
		expect(searchCalls[0]).toBe(4)
		delete process.env.KIMCHI_MEMORY_DIGEST_SELECTION_MIN_CANDIDATES
	})

	it("the digest gate off (subset env): no selector call, threshold rule applies", async () => {
		const decisionFetch = vi.fn(async () => {
			throw new Error("must not be called")
		})
		const { start } = await setup(
			createMemoryExtension({
				isEnabled: () => true,
				createSearcher: async () => ({ search: vi.fn(async () => searchable()) }),
				decision: () => ({
					gate: { endpoint: "https://gw.test/typesafe/v1/systemone", apiKey: "k", fetchImpl: decisionFetch },
					enabled: new Set(["valuation"]), // digest NOT enabled
				}),
			}),
		)
		const turn1 = await start(startEvent("memory check"), fakeCtx)
		expect(turn1?.systemPrompt).toContain("greplier")
		expect(decisionFetch).not.toHaveBeenCalled()
	})

	/** Recall-gate stub: sequence of lookup verdicts, one per call. */
	function recallFetchImpl(verdicts: Array<"search" | "skip">): { fetchImpl: typeof fetch; calls: string[] } {
		const calls: string[] = []
		let index = 0
		const fetchImpl: typeof fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { state: string }
			calls.push(body.state)
			const verdict = verdicts[Math.min(index, verdicts.length - 1)] ?? "search"
			index += 1
			return new Response(
				JSON.stringify({
					answers: {
						lookup: {
							type: "choice",
							choice: verdict,
							probabilities: { search: verdict === "search" ? 0.9 : 0.1, skip: verdict === "skip" ? 0.9 : 0.1 },
							confidence: 0.9,
						},
					},
					usage: { input_tokens: 100, output_tokens: 0 },
				}),
				{ status: 200 },
			)
		}
		return { fetchImpl, calls }
	}

	it("recall gating (E4): an uncovered turn skips the search when the gate says skip", async () => {
		const search = vi.fn(async () => [{ memory: "weak", score: 0.1 }]) // never clears the bar
		const gate = recallFetchImpl(["skip", "search"])
		const { start } = await setup(
			createMemoryExtension({
				isEnabled: () => true,
				createSearcher: async () => ({ search }),
				decision: () => ({
					gate: { endpoint: "https://gw.test/typesafe/v1/systemone", apiKey: "k", fetchImpl: gate.fetchImpl },
					enabled: new Set(["recall"]),
				}),
			}),
		)
		await start(startEvent("turn 1 - hi"), fakeCtx)
		expect(search).toHaveBeenCalledTimes(1) // the digest search
		// Turn 2 drifts out of (empty) delivered territory; the gate says skip.
		await start(startEvent("turn 2 - new topic about latency"), fakeCtx)
		await settle()
		expect(search).toHaveBeenCalledTimes(1)
		expect(gate.calls).toHaveLength(1)
		expect(gate.calls[0]).toContain("(none injected)")
		// Turn 3: the gate says search — retrieval pays despite prior skip.
		await start(startEvent("turn 3 - another fresh topic"), fakeCtx)
		await flushRecall(() => expect(search).toHaveBeenCalledTimes(2))
	})

	it("a recall-gate failure falls back to searching (fail-open)", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const search = vi.fn(async () => [{ memory: "weak", score: 0.1 }])
			const down = async () => new Response(JSON.stringify({ error: "quota" }), { status: 401 })
			const { start } = await setup(
				createMemoryExtension({
					isEnabled: () => true,
					createSearcher: async () => ({ search }),
					decision: () => ({
						gate: { endpoint: "https://gw.test/typesafe/v1/systemone", apiKey: "k", fetchImpl: down, maxRetries: 0 },
						enabled: new Set(["recall"]),
					}),
				}),
			)
			await start(startEvent("turn 1"), fakeCtx)
			await start(startEvent("turn 2 - drift"), fakeCtx)
			await flushRecall(() => expect(search).toHaveBeenCalledTimes(2))
			expect(consoleError.mock.calls.some((call) => String(call[0]).includes("recall gating failed"))).toBe(true)
		} finally {
			consoleError.mockRestore()
		}
	})
})

describe("memory status over the ACP bridge", () => {
	it("forwards the delivered count and the disable clear to ACP clients", async () => {
		// Real ACP ui context over a minimal fake conn — setStatus forwards
		// unconditionally (no capability gate), proving the composition the
		// docs claim: hasUI guard → extension emission → _kimchi.dev/pi_notify.
		const extNotification = vi.fn(async (_method: string, _params: Record<string, unknown>) => {})
		const conn = { extNotification } as unknown as AgentSideConnection
		const acpUi = createAcpUIContext(conn, "sess-1", undefined, vi.fn())
		const ctx = createContext({ ui: acpUi })
		const search = vi.fn(async () => [{ memory: "user prefers pnpm over npm", score: 0.7 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		await start(startEvent("set up the repo"), ctx)
		await new Promise((r) => setImmediate(r))

		const memoryStatusCalls = () =>
			extNotification.mock.calls.filter(
				(call) =>
					call[0] === "_kimchi.dev/pi_notify" &&
					(call[1] as { method?: string; statusKey?: string }).method === "setStatus" &&
					(call[1] as { statusKey?: string }).statusKey === MEMORY_STATUS_KEY,
			)

		// The delivered count reached the ACP client with the exact wire shape.
		expect(memoryStatusCalls().length).toBeGreaterThanOrEqual(1)
		expect(memoryStatusCalls()[0]?.[1]).toEqual({
			id: expect.any(String),
			type: "extension_ui_request",
			method: "setStatus",
			sessionId: "sess-1",
			statusKey: MEMORY_STATUS_KEY,
			statusText: "1",
		})

		// Session toggle off (what the ACP set_memory_enabled ext-method
		// writes): the clear must reach ACP clients as statusText undefined.
		setSessionMemoryOverride(ctx.sessionManager, false)
		await start(startEvent("turn 2"), ctx)
		await new Promise((r) => setImmediate(r))
		const cleared = memoryStatusCalls().at(-1)?.[1] as { statusText?: string } | undefined
		expect(cleared?.statusText).toBeUndefined()
	})
})

describe("memory saved feedback (completion record)", () => {
	const realHome = process.env.HOME
	let home: string

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "kimchi-memory-saved-"))
		process.env.HOME = home
	})

	afterEach(() => {
		process.env.HOME = realHome
		rmSync(home, { recursive: true, force: true })
	})

	/** The capture id the extension instance under test runs with. */
	const CAPTURE_ID = "22222222-3333-4444-5555-666666666666"

	/** Seed the worker's completion record for the given sessions. */
	const writeRecordEntries = (sessions: Record<string, number>): void => {
		const dir = join(home, ".config", "kimchi", "memory")
		mkdirSync(dir, { recursive: true })
		const now = Date.now()
		const entries: Record<string, { factsAdded: number; updatedAt: number }> = {}
		for (const [id, factsAdded] of Object.entries(sessions)) entries[id] = { factsAdded, updatedAt: now }
		writeFileSync(join(dir, "capture-completions.json"), JSON.stringify({ sessions: entries }))
	}

	/** Seed the record for THIS extension's capture session. */
	const writeRecord = (factsAdded: number): void => writeRecordEntries({ [CAPTURE_ID]: factsAdded })

	it("keeps the saved half in the segment without notifications", async () => {
		const ctx = createContext()
		const search = vi.fn(async () => [{ memory: "user prefers pnpm over npm", score: 0.7 }])
		const { start } = await setup(
			createMemoryExtension({
				isEnabled: () => true,
				createSearcher: async () => ({ search }),
				captureId: CAPTURE_ID,
			}),
		)
		// Nothing recorded yet — no saved status.
		await start(startEvent("set up the repo"), ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls.every((call) => call[0] !== MEMORY_SAVED_STATUS_KEY)).toBe(true)

		// A drain commits one fact for this capture session → next turn sets
		// the segment's saved half.
		writeRecord(1)
		await start(startEvent("next turn"), ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_SAVED_STATUS_KEY, "1"])

		// No change → the status is not re-set for the same commit.
		await start(startEvent("third turn"), ctx)
		// A later commit adds more → the status grows.
		writeRecord(3)
		await start(startEvent("fourth turn"), ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_SAVED_STATUS_KEY, "3"])
		// Saves never announce — the segment half is the only surface.
		expect(vi.mocked(ctx.ui.notify).mock.calls.every((call) => !String(call[0]).startsWith("Saved"))).toBe(true)
	})

	it("attributes saved counts per capture session (one process, two runtimes)", async () => {
		const ctx = createContext()
		const search = vi.fn(async () => [{ memory: "user prefers pnpm over npm", score: 0.7 }])
		const { start } = await setup(
			createMemoryExtension({
				isEnabled: () => true,
				createSearcher: async () => ({ search }),
				captureId: "capture-a",
			}),
		)
		// Two record entries — only this instance's id may show in its segment.
		writeRecordEntries({ "capture-a": 2, "capture-b": 5 })
		await start(startEvent("set up the repo"), ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_SAVED_STATUS_KEY, "2"])
	})

	it("clears the saved half when the session toggle disables memory", async () => {
		const ctx = createContext()
		const search = vi.fn(async () => [{ memory: "user prefers pnpm over npm", score: 0.7 }])
		const { start } = await setup(
			createMemoryExtension({
				isEnabled: () => true,
				createSearcher: async () => ({ search }),
				captureId: CAPTURE_ID,
			}),
		)
		writeRecord(2)
		await start(startEvent("set up the repo"), ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_SAVED_STATUS_KEY, "2"])
		setSessionMemoryOverride(ctx.sessionManager, false)
		await start(startEvent("turn 2"), ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls.at(-1)).toEqual([MEMORY_SAVED_STATUS_KEY, undefined])
	})

	it("the /memory disable command clears both segment halves at once", async () => {
		const admin = await import("./admin.js")
		const { api, getRegisteredCommand } = createExtensionApi()
		createMemoryExtension({ isEnabled: () => true, createSearcher: async () => hits(), captureId: CAPTURE_ID })(api)
		const command = getRegisteredCommand("memory")
		const ctx = createCommandContext()
		vi.mocked(admin.runAdminCommand).mockImplementation(async (_args, opts) => {
			opts?.memoryState?.setSession(false)
			return { text: "Memory disabled for this session — resets on restart.", json: "{}", code: 0, useJson: false }
		})
		await command.handler("disable", ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_STATUS_KEY, undefined])
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_SAVED_STATUS_KEY, undefined])
	})

	it("a successful /memory reset clears both halves and re-derives from the record", async () => {
		const admin = await import("./admin.js")
		const { api, getRegisteredCommand, getHandler } = createExtensionApi()
		createMemoryExtension({ isEnabled: () => true, createSearcher: async () => hits(), captureId: CAPTURE_ID })(api)
		const command = getRegisteredCommand("memory")
		const ctx = createContext()
		const start = getHandler<BeforeAgentStartEvent, { systemPrompt?: string } | undefined>("before_agent_start")

		writeRecord(2)
		await start(startEvent("set up the repo"), ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_SAVED_STATUS_KEY, "2"])

		vi.mocked(admin.runAdminCommand).mockResolvedValue({
			text: "All memories deleted.",
			json: "{}",
			code: 0,
			useJson: false,
		})
		const cmdCtx = createCommandContext()
		// reset requires --scope (parseAdminArgs) — the grammar the handler sees.
		await command.handler("reset --scope all --yes", cmdCtx)
		expect(vi.mocked(cmdCtx.ui.setStatus).mock.calls).toContainEqual([MEMORY_STATUS_KEY, undefined])
		expect(vi.mocked(cmdCtx.ui.setStatus).mock.calls).toContainEqual([MEMORY_SAVED_STATUS_KEY, undefined])

		// The watermark reset means a later record read re-surfaces from zero.
		writeRecord(3)
		await start(startEvent("turn 2"), ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls).toContainEqual([MEMORY_SAVED_STATUS_KEY, "3"])
	})
})

describe("authored lane wiring (KIMCHI_MEMORY_AUTHORED)", () => {
	afterEach(() => {
		delete process.env.KIMCHI_MEMORY_AUTHORED
	})

	it("flag OFF: save_memory is not registered", () => {
		const { api, getRegisteredTool } = createExtensionApi()
		createMemoryExtension({ isEnabled: () => true, createSearcher: async () => hits() })(api)
		expect(() => getRegisteredTool("save_memory")).toThrow(/not registered/)
	})

	it("flag ON: save_memory is registered (only then can the model write)", () => {
		process.env.KIMCHI_MEMORY_AUTHORED = "1"
		const { api, getRegisteredTool } = createExtensionApi()
		createMemoryExtension({ isEnabled: () => true, createSearcher: async () => hits() })(api)
		expect(getRegisteredTool("save_memory")).toBeDefined()
		expect(getRegisteredTool("save_memory")?.name).toBe("save_memory")
	})

	it("the system-prompt notice never contradicts the registered tool surface", () => {
		process.env.KIMCHI_MEMORY_AUTHORED = "1"
		expect(memoryEnabledNotice()).toContain("save_memory")
		expect(memoryEnabledNotice()).not.toContain("there is no write tool")
		delete process.env.KIMCHI_MEMORY_AUTHORED
		expect(memoryEnabledNotice()).toContain("there is no write tool to call")
		expect(memoryEnabledNotice()).not.toContain("save_memory")
	})
})

describe("authored lane redaction parity", () => {
	it("save_memory redacts credential-shaped facts before persisting", async () => {
		const stored: string[] = []
		const tool = createMemorySaveTool({
			write: async (text) => {
				stored.push(text)
			},
			existing: async () => [],
			isEnabled: () => true,
		})
		await tool.execute(
			"call-1",
			{ fact: "The gateway key is sk-proj-AbCdEf1234567890GhIjKlMnOpQrStUvWx in the shared config." },
			undefined,
			undefined,
			{} as never,
		)
		expect(stored).toHaveLength(1)
		expect(stored[0]).toContain("[authored]")
		expect(stored[0]).toContain("[REDACTED-")
		expect(stored[0]).not.toContain("sk-proj-")
	})
})
