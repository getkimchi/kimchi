import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { populateCliArgs } from "../../cli-args.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createMemoryExtension, type MemorySearcher } from "./index.js"

const BASE_PROMPT = "You are kimchi."

function hits(...items: Array<{ memory: string; score: number }>): MemorySearcher {
	return { search: vi.fn(async () => items) }
}

function startEvent(prompt: string): BeforeAgentStartEvent {
	return { type: "before_agent_start", systemPrompt: BASE_PROMPT, prompt } as BeforeAgentStartEvent
}

async function setup(extension: (pi: ExtensionAPI) => void) {
	const { api, getHandler } = createExtensionApi()
	extension(api)
	const start = getHandler<BeforeAgentStartEvent, { systemPrompt?: string } | undefined>("before_agent_start")
	return { api, getHandler, start }
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
	})

	it("carries the digest from the very first start and keeps it byte-stable across turns", async () => {
		const { start } = await setup(
			createMemoryExtension({
				isEnabled: () => true,
				createSearcher: async () =>
					hits({ memory: "user prefers pnpm over npm", score: 0.7 }, { memory: "unrelated", score: 0.1 }),
			}),
		)
		const turn1 = await start(startEvent("set up the repo"), {} as never)
		expect(turn1?.systemPrompt).toContain("user prefers pnpm over npm")
		expect(turn1?.systemPrompt).not.toContain("unrelated")

		// Turns 2 and 3 must be byte-identical to turn 1 — the stable-prefix
		// cache contract (zero mid-session prompt changes attributable to memory).
		const turn2 = await start(startEvent("next turn"), {} as never)
		const turn3 = await start(startEvent("third"), {} as never)
		expect(turn2?.systemPrompt).toBe(turn1?.systemPrompt)
		expect(turn3?.systemPrompt).toBe(turn1?.systemPrompt)
	})

	it("searches exactly once per session — an empty digest injects nothing ever", async () => {
		const search = vi.fn(async () => [{ memory: "weak", score: 0.1 }])
		const { start } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) }),
		)
		for (let turn = 0; turn < 3; turn++) {
			const result = await start(startEvent(`turn ${turn}`), {} as never)
			expect(result).toBeUndefined()
		}
		expect(search).toHaveBeenCalledTimes(1)
	})

	it("recomputes the digest after compaction, then goes stable again", async () => {
		const searcher = { search: vi.fn(async () => [{ memory: "post-compact fact", score: 0.6 }]) }
		const { start, getHandler } = await setup(
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => searcher }),
		)
		const compact = getHandler("session_compact")

		const first = await start(startEvent("turn 1"), {} as never)
		expect(first?.systemPrompt).toContain("post-compact fact")

		compact({ type: "session_compact" }, {} as never)
		const afterCompact = await start(startEvent("turn 2"), {} as never)
		expect(afterCompact?.systemPrompt).toContain("post-compact fact")
		expect(searcher.search).toHaveBeenCalledTimes(2)

		const later = await start(startEvent("turn 3"), {} as never)
		expect(later?.systemPrompt).toBe(afterCompact?.systemPrompt)
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
				const result = await start(startEvent(`turn ${turn}`), {} as never)
				expect(result).toBeUndefined()
			}
			expect(consoleError).toHaveBeenCalledTimes(1)
			expect(consoleError.mock.calls[0]?.[0]).toContain("[memory]")
		} finally {
			consoleError.mockRestore()
		}
	})

	it("honors the --memory CLI flag via getParsedCliArgs", async () => {
		populateCliArgs(["--memory"])
		const searcher = { search: vi.fn(async () => [{ memory: "flag fact", score: 0.6 }]) }
		const { start } = await setup(createMemoryExtension({ createSearcher: async () => searcher }))
		const result = await start(startEvent("turn"), {} as never)
		expect(result?.systemPrompt).toContain("flag fact")
		populateCliArgs([])
	})
})
