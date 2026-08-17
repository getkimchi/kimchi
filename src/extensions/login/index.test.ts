import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import loginExtension from "./index.js"

const { clearApiKeyMock, loadConfigMock } = vi.hoisted(() => ({
	clearApiKeyMock: vi.fn(),
	loadConfigMock: vi.fn(),
}))

vi.mock("../../config.js", () => ({
	clearApiKey: clearApiKeyMock,
	loadConfig: loadConfigMock,
	writeApiKey: vi.fn(),
}))

vi.mock("../billing/status.js", () => ({
	refreshBillingStatusFromConfig: vi.fn(),
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
		expect(config.oauth?.name).toBe("Kimchi")
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
		expect(config.oauth?.name).toBe("Kimchi")
	})

	it("restores OpenAI Codex subscription login while builtin API-key providers stay disabled", () => {
		loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint: undefined })
		const registerProvider = vi.fn()

		loginExtension({
			on: vi.fn(),
			registerProvider,
		} as unknown as ExtensionAPI)

		expect(registerProvider.mock.calls[0]?.[0]).toMatchObject({
			id: "openai-codex",
			name: "OpenAI Codex",
			auth: { oauth: { name: "OpenAI (ChatGPT Plus/Pro)" } },
		})
	})

	it("logs out every internal Kimchi provider when the single Kimchi entry is selected", () => {
		loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint: undefined })
		const on = vi.fn()
		const originalLogout = vi.fn()
		const authStorage = { logout: originalLogout }
		const modelRegistry = {
			authStorage,
			getAll: () => [
				{ id: "sol", provider: "kimchi-dev" },
				{ id: "sol", provider: "kimchi-dev/openai" },
				{ id: "claude", provider: "kimchi-dev/anthropic" },
			],
		}

		loginExtension({ on, registerProvider: vi.fn() } as unknown as ExtensionAPI)
		const sessionStart = on.mock.calls[0]?.[1]
		sessionStart({}, { modelRegistry })
		authStorage.logout("kimchi-dev")

		expect(originalLogout.mock.calls.map(([provider]) => provider)).toEqual([
			"kimchi-dev",
			"kimchi-dev/openai",
			"kimchi-dev/anthropic",
		])
		expect(clearApiKeyMock).toHaveBeenCalledOnce()
	})
})
