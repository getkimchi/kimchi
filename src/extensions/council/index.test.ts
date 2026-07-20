import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import councilExtension from "./index.js"

type ProviderConfig = Parameters<ModelRegistry["registerProvider"]>[1]

function register(): {
	appendEntry: ReturnType<typeof vi.fn>
	config: ProviderConfig
	on: ReturnType<typeof vi.fn>
	registerProvider: ReturnType<typeof vi.fn>
} {
	vi.stubEnv("KIMCHI_COUNCIL_ENABLED", "true")
	const on = vi.fn()
	const registerProvider = vi.fn()
	const appendEntry = vi.fn()
	councilExtension({ appendEntry, on, registerProvider } as unknown as ExtensionAPI)
	const [provider, config] = registerProvider.mock.calls[0]
	expect(provider).toBe("kimchi")
	return { appendEntry, config, on, registerProvider }
}

const councilModel = {
	id: "council",
	name: "Kimchi Council",
	api: "kimchi-council",
	provider: "kimchi",
	baseUrl: "http://kimchi-council.invalid",
	reasoning: false,
	input: ["text"] as const,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 32_768,
} satisfies Model<Api>

describe("councilExtension", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("registers kimchi/council as an inert virtual provider", () => {
		const { config } = register()

		expect(config).toMatchObject({
			api: "kimchi-council",
			baseUrl: "http://kimchi-council.invalid",
			apiKey: "unused-virtual-model-key",
			authHeader: false,
		})
		expect(config.models).toEqual([
			expect.objectContaining({ id: "council", name: "Kimchi Council", reasoning: false }),
		])
		expect(config.streamSimple).toBeTypeOf("function")
	})

	it("skips registration when Council is disabled", () => {
		vi.stubEnv("KIMCHI_COUNCIL_ENABLED", "false")
		const registerProvider = vi.fn()

		councilExtension({ on: vi.fn(), registerProvider } as unknown as ExtensionAPI)

		expect(registerProvider).not.toHaveBeenCalled()
	})

	it("uses the model registry from session_start for physical resolution", async () => {
		const { appendEntry, config, on } = register()
		const find = vi.fn()
		const registry = { find, getApiKeyAndHeaders: vi.fn() } as unknown as ModelRegistry
		const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const sessionShutdown = on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		sessionStart({}, { modelRegistry: registry, sessionManager: { getSessionId: () => "session-a" } })

		const result = await config.streamSimple?.(councilModel, { messages: [] }, { sessionId: "session-a" }).result()
		sessionShutdown()

		expect(find).toHaveBeenCalledWith("kimchi-dev", "kimi-k2.7")
		expect(result?.errorMessage).toBe("Council could not produce a complete lead response")
		expect(appendEntry).toHaveBeenCalledWith(
			"council_run",
			expect.objectContaining({ outcome: "error", virtualModel: "kimchi/council" }),
		)
	})

	it("routes concurrent sessions to their own registry and run record", async () => {
		const first = register()
		const second = register()
		const firstFind = vi.fn()
		const secondFind = vi.fn()
		const firstRegistry = { find: firstFind, getApiKeyAndHeaders: vi.fn() } as unknown as ModelRegistry
		const secondRegistry = { find: secondFind, getApiKeyAndHeaders: vi.fn() } as unknown as ModelRegistry
		const firstStart = first.on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const secondStart = second.on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const firstShutdown = first.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		const secondShutdown = second.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		firstStart({}, { modelRegistry: firstRegistry, sessionManager: { getSessionId: () => "first" } })
		secondStart({}, { modelRegistry: secondRegistry, sessionManager: { getSessionId: () => "second" } })

		try {
			await first.config.streamSimple?.(councilModel, { messages: [] }, { sessionId: "first" }).result()

			expect(first.config.streamSimple).toBe(second.config.streamSimple)
			expect(firstFind).toHaveBeenCalledWith("kimchi-dev", "kimi-k2.7")
			expect(secondFind).not.toHaveBeenCalled()
			expect(first.appendEntry).toHaveBeenCalledWith(
				"council_run",
				expect.objectContaining({ virtualModel: "kimchi/council" }),
			)
			expect(second.appendEntry).not.toHaveBeenCalled()

			firstShutdown()
			await first.config.streamSimple?.(councilModel, { messages: [] }, { sessionId: "first" }).result()
			await second.config.streamSimple?.(councilModel, { messages: [] }, { sessionId: "second" }).result()

			expect(firstFind).toHaveBeenCalledTimes(1)
			expect(first.appendEntry).toHaveBeenCalledTimes(1)
			expect(secondFind).toHaveBeenCalledWith("kimchi-dev", "kimi-k2.7")
			expect(second.appendEntry).toHaveBeenCalledTimes(1)
		} finally {
			firstShutdown()
			secondShutdown()
		}
	})
})
