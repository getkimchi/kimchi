import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prepareActivePromptKimchiCredential } from "../../auth/active-prompt-refresh.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createModel } from "../__mocks__/model-registry.js"
import loginExtension from "./index.js"

const { acpMode, loadConfigMock, prepareActivePromptMock, refreshBillingStatusFromConfigMock } = vi.hoisted(() => ({
	acpMode: { current: false },
	loadConfigMock: vi.fn(),
	prepareActivePromptMock: vi.fn(),
	refreshBillingStatusFromConfigMock: vi.fn(),
}))

vi.mock("../../modes/acp/state.js", async (importOriginal) => ({
	...(await importOriginal()),
	get IS_ACP_MODE() {
		return acpMode.current
	},
}))

vi.mock("../../auth/active-prompt-refresh.js", () => ({
	prepareActivePromptKimchiCredential: prepareActivePromptMock,
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
	const { api, registerProvider } = createExtensionApi()
	loginExtension(api)
	const [providerId, providerConfig] = registerProvider.mock.calls.find(([provider]) => provider === "kimchi-dev") ?? []
	if (providerId !== "kimchi-dev" || !providerConfig) throw new Error("Kimi provider was not registered")
	return providerConfig
}

describe("loginExtension", () => {
	beforeEach(() => {
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "/tmp/kimchi-login-extension-test")
		acpMode.current = false
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
		const { api, registerProvider } = createExtensionApi()
		loginExtension(api)

		// Stock pi login flow, re-labelled without "(legacy)", with no hardcoded
		// models (the gateway feed supplies them).
		const provider = registerProvider.mock.calls[0]?.[0]
		expect(provider).toMatchObject({
			id: "kimchi-dev/openai-codex",
			name: "OpenAI Codex",
			auth: { oauth: { name: "OpenAI (ChatGPT Plus/Pro)" } },
		})
		expect(provider.getModels()).toEqual([])
	})

	it("stops the prompt after transient canonical failure and requests a retry, not sign-in", async () => {
		loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint: undefined })
		vi.mocked(prepareActivePromptKimchiCredential).mockResolvedValue("oauth_refresh_failed")
		const { api, getHandler } = createExtensionApi()
		const notify = vi.fn()
		loginExtension(api)

		await expect(getHandler("input")({ source: "interactive" }, createContext({ ui: { notify } }))).resolves.toEqual({
			action: "handled",
		})
		expect(notify).toHaveBeenCalledWith("OAuth refresh failed. Retry this prompt; sign-in is not required.", "error")
	})

	it("handles a credential-sync failure without submitting or requesting sign-in", async () => {
		loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint: undefined })
		vi.mocked(prepareActivePromptKimchiCredential).mockResolvedValue("credential_sync_failed")
		const { api, getHandler } = createExtensionApi()
		const notify = vi.fn()
		loginExtension(api)

		await expect(getHandler("input")({ source: "interactive" }, createContext({ ui: { notify } }))).resolves.toEqual({
			action: "handled",
		})
		expect(notify).toHaveBeenCalledWith(
			"OAuth refresh succeeded, but the active credential could not be saved. Retry this prompt; sign-in is not required.",
			"error",
		)
	})

	it("keeps ACP's session-owned provider callbacks on session_start", () => {
		acpMode.current = true
		loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint: undefined })
		const { api, getHandler, registerProvider } = createExtensionApi()
		loginExtension(api)
		registerProvider.mockClear()

		getHandler("session_start")({}, createContext({ mode: "rpc", modelRegistry: { getAll: () => [] } }))

		expect(registerProvider).not.toHaveBeenCalled()
	})

	it("registers canonical and child OAuth handlers for native RPC session_start", () => {
		loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint: undefined })
		const { api, getHandler, registerProvider } = createExtensionApi()
		loginExtension(api)
		registerProvider.mockClear()

		getHandler("session_start")(
			{},
			createContext({
				mode: "rpc",
				modelRegistry: { getAll: () => [createModel("child-model", "kimchi-dev/openai")] },
			}),
		)

		expect(registerProvider).toHaveBeenCalledTimes(2)
		for (const providerId of ["kimchi-dev", "kimchi-dev/openai"]) {
			expect(registerProvider).toHaveBeenCalledWith(
				providerId,
				expect.objectContaining({
					oauth: expect.objectContaining({
						name: "Sign in with SSO",
						refreshToken: expect.any(Function),
						getApiKey: expect.any(Function),
					}),
				}),
			)
		}
	})

	it("refreshes billing when an authenticated session starts", () => {
		loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint: undefined })
		const { api, getHandler } = createExtensionApi()
		loginExtension(api)
		loadConfigMock.mockReturnValue({ apiKey: "configured-api-key", customLlmEndpoint: undefined })

		getHandler("session_start")({}, createContext({ modelRegistry: { getAll: () => [] } }))

		expect(refreshBillingStatusFromConfigMock).toHaveBeenCalledOnce()
		expect(refreshBillingStatusFromConfigMock).toHaveBeenCalledWith({ mode: "forced" })
	})
})
