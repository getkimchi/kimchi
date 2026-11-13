import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { codexRequestMetadata, resetCodexSession } from "./codex-request-context.js"
import loginExtension from "./index.js"

const { loadConfigMock, refreshBillingStatusFromConfigMock } = vi.hoisted(() => ({
	loadConfigMock: vi.fn(),
	refreshBillingStatusFromConfigMock: vi.fn(),
}))

vi.mock("../../config.js", () => ({
	loadConfig: loadConfigMock,
	writeApiKey: vi.fn(),
}))

vi.mock("../billing/status.js", () => ({
	refreshBillingStatusFromConfig: refreshBillingStatusFromConfigMock,
}))

// Keep the real chatCompletionsApi (URL builder + scheme normalization) so baseUrl assertions
// exercise the real behavior; stub only the network/fs helpers the extension imports here.
vi.mock("../../models.js", async (importActual) => ({
	...(await importActual<typeof import("../../models.js")>()),
	updateModelsConfig: vi.fn(),
	validateApiKey: vi.fn(),
}))

type ProviderConfig = Parameters<ModelRegistry["registerProvider"]>[1]

// Capture the provider config the extension registers for a given customLlmEndpoint.
function providerConfigFor(customLlmEndpoint: string | undefined): ProviderConfig {
	loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint })
	const registerProvider = vi.fn()
	loginExtension({ on: vi.fn(), registerProvider } as unknown as ExtensionAPI)
	const [providerId, providerConfig] = registerProvider.mock.calls.find(([provider]) => provider === "kimchi-dev") ?? []
	expect(providerId).toBe("kimchi-dev")
	return providerConfig
}

describe("loginExtension", () => {
	beforeEach(() => {
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "/tmp/kimchi-login-extension-test")
		loadConfigMock.mockReset()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.clearAllMocks()
	})

	it("registers an in-memory baseUrl override for a custom endpoint, keeping /login", () => {
		const config = providerConfigFor("https://override.example/") // trailing slash must collapse
		expect(config.baseUrl).toBe("https://override.example/openai/v1")
		expect(config.oauth?.name).toBe("Sign in with SSO")
	})

	it("prefixes a scheme-less endpoint with https:// so the override is a valid URL", () => {
		// A bare "example.com" would otherwise be an invalid baseUrl that the HTTP layer drops,
		// silently falling back to the gateway (the #814 bug).
		const config = providerConfigFor("example.com")
		expect(config.baseUrl).toBe("https://example.com/openai/v1")
	})

	it("registers no baseUrl override when no custom endpoint is set, leaving models.json in charge", () => {
		const config = providerConfigFor(undefined)
		expect(config.baseUrl).toBeUndefined()
		expect(config.oauth?.name).toBe("Sign in with SSO")
	})

	it("restores OpenAI Codex subscription login while builtin API-key providers stay disabled", () => {
		loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint: undefined })
		const registerProvider = vi.fn()

		loginExtension({
			on: vi.fn(),
			registerProvider,
		} as unknown as ExtensionAPI)

		// Stock pi login flow, re-labelled without "(legacy)", with no hardcoded
		// models (the gateway feed supplies them).
		const provider = registerProvider.mock.calls[0]?.[0]
		expect(provider).toMatchObject({
			id: "openai-codex",
			name: "OpenAI Codex",
			auth: { oauth: { name: "OpenAI (ChatGPT Plus/Pro)" } },
		})
		expect(provider.getModels()).toEqual([])
	})

	it("refreshes billing when an authenticated session starts", () => {
		loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint: undefined })
		const on = vi.fn()

		loginExtension({ on, registerProvider: vi.fn() } as unknown as ExtensionAPI)
		loadConfigMock.mockReturnValue({ apiKey: "configured-api-key", customLlmEndpoint: undefined })

		const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1]
		sessionStart({}, { modelRegistry: { getAll: () => [] } })

		expect(refreshBillingStatusFromConfigMock).toHaveBeenCalledOnce()
		expect(refreshBillingStatusFromConfigMock).toHaveBeenCalledWith({ mode: "forced" })
	})

	it("registers Codex session handlers", () => {
		loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint: undefined })
		const on = vi.fn()
		loginExtension({ on, registerProvider: vi.fn() } as unknown as ExtensionAPI)
		const events = on.mock.calls.map(([event]) => event)
		for (const event of [
			"before_agent_start",
			"session_before_compact",
			"session_compact",
			"session_compact_failed",
			"session_shutdown",
		]) {
			expect(events).toContain(event)
		}
	})

	it("a turn's window number comes from the current branch", () => {
		loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint: undefined })
		const on = vi.fn()
		loginExtension({ on, registerProvider: vi.fn() } as unknown as ExtensionAPI)
		const beforeAgentStart = on.mock.calls.find(([event]) => event === "before_agent_start")?.[1]
		const ctxWith = (branch: { type: string }[]) => ({
			sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
		})
		resetCodexSession("s1")

		beforeAgentStart({}, ctxWith([{ type: "message" }, { type: "compaction" }, { type: "compaction" }]))
		expect(codexRequestMetadata("s1").windowNumber).toBe(2)

		beforeAgentStart({}, ctxWith([{ type: "compaction" }]))
		expect(codexRequestMetadata("s1").windowNumber).toBe(1)
		resetCodexSession("s1")
	})
})
