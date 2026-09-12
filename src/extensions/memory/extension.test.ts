import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { populateCliArgs } from "../../cli-args.js"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { MEMORY_SEARCH_TIMEOUT_MS } from "./config.js"
import { createMemoryExtension, type MemorySearcher } from "./index.js"
import { MemoryPanel } from "./memory-panel.js"

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

const BASE_PROMPT = "You are kimchi."

// Handler ctx: the shared mock factory (repo testing rule — no hand-rolled
// ctx mocks). The incremental-capture call reads getEntries() on every
// before_agent_start; the factory provides an empty one.
const fakeCtx = createContext()

function hits(...items: Array<{ memory: string; score: number }>): MemorySearcher {
	return { search: vi.fn(async () => items) }
}

function startEvent(prompt: string): BeforeAgentStartEvent {
	return { type: "before_agent_start", systemPrompt: BASE_PROMPT, prompt } as BeforeAgentStartEvent
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
		expect(admin.adminListFacts).toHaveBeenCalledWith({ kind: "all" })
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

		// A non-UI context (ACP/print mode) prints plainly to the console.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			const plainCtx = { ...createCommandContext(), hasUI: false }
			vi.mocked(admin.runAdminCommand).mockResolvedValue({
				text: "plain output",
				json: "{}",
				code: 0,
				useJson: false,
			})
			await command.handler("list", plainCtx)
			expect(admin.adminListFacts).toHaveBeenCalledTimes(1) // panel routing requires a UI
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

	it("an empty digest injects no facts — only the always-on notice (drift retries bounded by the cap)", async () => {
		const search = vi.fn(async () => [{ memory: "weak", score: 0.1 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		for (let turn = 0; turn < 3; turn++) {
			const result = await start(startEvent(`turn ${turn}`), fakeCtx)
			// The model must know capture is automatic even with no digest, and
			// where the user manages what is stored.
			expect(result?.systemPrompt).toContain("captured automatically")
			expect(result?.systemPrompt).toContain("/memory")
			expect(result?.systemPrompt).toContain("kimchi memory")
			expect(result?.systemPrompt).not.toContain("weak")
		}
		// Turn 1 (digest) + turns 2-3: nothing was delivered, so the gate sees
		// drift and retries retrieval — the session cap bounds this.
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

	it("degrades to no-memory when the digest search hangs (bounded timeout)", async () => {
		vi.useFakeTimers()
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const { start } = await setup(
				createMemoryExtension({
					isEnabled: () => true,
					// A hung gateway call — never resolves.
					createSearcher: async () => ({
						search: () => new Promise<Array<{ memory?: string }>>(() => {}),
					}),
				}),
			)
			const pending = start(startEvent("turn 1"), fakeCtx)
			await vi.advanceTimersByTimeAsync(MEMORY_SEARCH_TIMEOUT_MS + 10)
			const result = await pending
			// Degraded to no facts — the notice is still present.
			expect(result?.systemPrompt).toContain("captured automatically")
			expect(consoleError.mock.calls.some(([m]) => String(m).includes("timed out"))).toBe(true)
		} finally {
			vi.useRealTimers()
			consoleError.mockRestore()
		}
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
		expect(turn2?.systemPrompt).toBe(turn1?.systemPrompt)
		expect(sendMessage).toHaveBeenCalledTimes(1)
		const [message, options] = sendMessage.mock.calls[0] as [
			{ customType: string; content: Array<{ type: string; text: string }>; display: boolean },
			{ deliverAs: string },
		]
		expect(message.customType).toBe("memory-recall")
		expect(message.display).toBe(false)
		expect(options.deliverAs).toBe("steer")
		expect(message.content[0]?.text).toContain("user bakes chocolate cakes")
		expect(message.content[0]?.text).not.toContain("pnpm")

		// Same territory again: the fact is already delivered — no second steer.
		await start(startEvent("more about baking?"), fakeCtx)
		expect(sendMessage).toHaveBeenCalledTimes(1)
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

	it("bounds progressive re-evaluations by the session cap", async () => {
		let n = 0
		const search = vi.fn(async () => [{ memory: `distinct fact number ${++n}`, score: 0.6 }])
		const { sendMessage, start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		for (let turn = 0; turn < 8; turn++) {
			await start(startEvent(`drift topic ${turn}`), fakeCtx)
		}
		// Turn 1 (digest) + TURN_RECALL_MAX_EVALUATIONS (5) drift retrievals —
		// the 6th+ drift turns are out of budget.
		expect(search).toHaveBeenCalledTimes(6)
		expect(sendMessage).toHaveBeenCalledTimes(5)
	})
})
