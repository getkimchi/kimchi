import { getModels } from "@earendil-works/pi-ai"
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as configModule from "./config.js"
import * as loginPatch from "./login-command-patch.js"
import * as modelsModule from "./models.js"

const { applyLoginCommandPatch, oauthDelegate, warningDelegate } = loginPatch

vi.mock("@earendil-works/pi-ai", async () => {
	const actual = await vi.importActual("@earendil-works/pi-ai")
	return {
		...(actual as object),
		getModels: vi.fn().mockReturnValue([]),
	}
})

beforeAll(() => {
	initTheme("default")
})

beforeEach(() => {
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "/tmp/kimchi-api-login-test")
	// Auth tests should be independent of the developer machine's real config.
	vi.spyOn(configModule, "loadConfig").mockReturnValue({ apiKey: "" } as ReturnType<typeof configModule.loadConfig>)
	vi.spyOn(configModule, "writeApiKey").mockImplementation(() => {})
	vi.spyOn(modelsModule, "updateModelsConfig").mockResolvedValue({ models: [] })
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	vi.mocked(getModels).mockReturnValue([])
})

function makeFakeModelRegistry() {
	return {
		authStorage: {
			set: vi.fn(),
			get: vi.fn(),
			remove: vi.fn(),
		},
		refresh: vi.fn(),
		getAvailable: vi.fn().mockReturnValue([]),
		getProviderAuthStatus: vi.fn().mockReturnValue({ configured: false }),
	}
}

// biome-ignore lint/suspicious/noExplicitAny: intentionally permissive fake object for testing prototype patches
type FakeIm = Record<string, any>

function makeFakeInteractiveMode(registry: ReturnType<typeof makeFakeModelRegistry>) {
	const children: unknown[] = []
	const fakeIm: FakeIm = {
		showError: vi.fn(),
		showStatus: vi.fn(),
		showLoginDialog: vi.fn().mockResolvedValue(undefined),
		showExtensionInput: vi.fn(),
		getLoginProviderOptions: vi.fn().mockReturnValue([]),
		chatContainer: {
			addChild: vi.fn((child: unknown) => children.push(child)),
			children,
		},
		ui: {
			requestRender: vi.fn(),
		},
		session: {
			modelRegistry: registry,
			setModel: vi.fn().mockResolvedValue(undefined),
		},
		showSelector: vi.fn((build: (done: () => void) => { component: unknown; focus?: unknown }) => {
			const result = build(() => {
				fakeIm.selectorDone = true
			})
			fakeIm.selectorComponent = result.component
			fakeIm.selectorFocus = result.focus
		}),
	}
	return fakeIm
}

function getFeedbackMessages(fakeIm: FakeIm): string[] {
	return fakeIm.chatContainer.children
		.filter((c: unknown): c is Text => c instanceof Text)
		.map((c: Text) => (c as unknown as { text: string }).text)
}

async function flushAsyncLogin(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0))
	await Promise.resolve()
}

function waitForMockCall(spy: { mock: { calls: unknown[][] } }, timeout = 1000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now()
		const interval = setInterval(() => {
			if (spy.mock.calls.length > 0) {
				clearInterval(interval)
				resolve()
			} else if (Date.now() - start > timeout) {
				clearInterval(interval)
				reject(new Error(`Timeout waiting for mock call after ${timeout}ms`))
			}
		}, 2)
	})
}

async function selectCurrentLoginOption(fakeIm: FakeIm): Promise<void> {
	fakeIm.selectorComponent.handleInput("\n")
	await flushAsyncLogin()
}

async function selectApiKeyLoginOption(fakeIm: FakeIm): Promise<void> {
	fakeIm.selectorComponent.handleInput("j")
	fakeIm.selectorComponent.handleInput("\n")
	await flushAsyncLogin()
}

async function selectSubscriptionLoginOption(fakeIm: FakeIm): Promise<void> {
	fakeIm.selectorComponent.handleInput("j")
	fakeIm.selectorComponent.handleInput("j")
	fakeIm.selectorComponent.handleInput("\n")
	await Promise.resolve()
}

it("intercepts showOAuthSelector('login') and runs Kimchi browser auth", async () => {
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "/tmp/kimchi-login-test")
	const cliAuthModule = await import("./cli-auth/index.js")
	const authSpy = vi.spyOn(cliAuthModule, "authenticateViaBrowser").mockResolvedValue({ token: "test-token-123" })

	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockReturnValue([{ id: "kimi-k2.6", provider: "kimchi-dev" }])

	const fakeIm = makeFakeInteractiveMode(registry)
	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectCurrentLoginOption(fakeIm)

	expect(fakeIm.showSelector).toHaveBeenCalledOnce()
	expect(authSpy).toHaveBeenCalledOnce()
	expect(fakeIm.showStatus).toHaveBeenCalledWith("Opening browser for Kimchi login...")
	expect(registry.authStorage.set).toHaveBeenCalledWith("kimchi-dev", {
		type: "api_key",
		key: "test-token-123",
	})
	expect(registry.refresh).toHaveBeenCalledOnce()
	expect(fakeIm.session.setModel).toHaveBeenCalledWith({
		id: "kimi-k2.6",
		provider: "kimchi-dev",
	})
	expect(getFeedbackMessages(fakeIm)).toContain(
		"Logged in to Kimchi. Selected kimi-k2.6. Credentials saved to /tmp/kimchi-login-test/auth.json",
	)
})

it("does not reuse a saved Kimchi key for explicit /login", async () => {
	vi.mocked(configModule.loadConfig).mockReturnValue({
		apiKey: "stale-saved-token",
	} as ReturnType<typeof configModule.loadConfig>)
	const cliAuthModule = await import("./cli-auth/index.js")
	const authSpy = vi.spyOn(cliAuthModule, "authenticateViaBrowser").mockResolvedValue({ token: "fresh-token" })

	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockReturnValue([{ id: "kimi-k2.6", provider: "kimchi-dev" }])

	const fakeIm = makeFakeInteractiveMode(registry)
	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectCurrentLoginOption(fakeIm)

	expect(authSpy).toHaveBeenCalledOnce()
	expect(fakeIm.showStatus).toHaveBeenCalledWith("Opening browser for Kimchi login...")
	expect(fakeIm.showStatus).not.toHaveBeenCalledWith("Refreshing Kimchi models with existing login...")
	expect(configModule.writeApiKey).toHaveBeenCalledWith("fresh-token")
	expect(registry.authStorage.set).toHaveBeenCalledWith("kimchi-dev", {
		type: "api_key",
		key: "fresh-token",
	})
	expect(fakeIm.session.setModel).toHaveBeenCalledWith({
		id: "kimi-k2.6",
		provider: "kimchi-dev",
	})
})

it("surfaces the login URL in the TUI so it can be copied into the right browser/profile", async () => {
	const loginUrl = "https://app.kimchi.dev/cli-auth?callback=http%3A%2F%2Flocalhost%3A51234&state=abc123"
	const cliAuthModule = await import("./cli-auth/index.js")
	vi.spyOn(cliAuthModule, "authenticateViaBrowser").mockImplementation(async (options) => {
		options?.onBrowserUrl?.(loginUrl)
		return { token: "test-token-url" }
	})

	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockReturnValue([{ id: "kimi-k2.6", provider: "kimchi-dev" }])

	const fakeIm = makeFakeInteractiveMode(registry)
	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectCurrentLoginOption(fakeIm)

	// Must be an intact OSC 8 hyperlink target (BEL-terminated, like upstream
	// showAuth) so "Copy Link" yields the full URL even when the visible text
	// wraps; a raw wrapped URL injects a newline that corrupts the state param.
	// The `id=` param groups the wrapped rows so the whole URL highlights as one link.
	const msg = getFeedbackMessages(fakeIm).find((m) => m.includes(`;${loginUrl}\x07`))
	expect(msg).toBeDefined()
	expect(msg).toContain("\x1b]8;id=kimchi-login-")
})

it("falls back to the first available model when the default is not present", async () => {
	const cliAuthModule = await import("./cli-auth/index.js")
	vi.spyOn(cliAuthModule, "authenticateViaBrowser").mockResolvedValue({
		token: "test-token-456",
	})

	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockReturnValue([{ id: "other-model", provider: "kimchi-dev" }])

	const fakeIm = makeFakeInteractiveMode(registry)
	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectCurrentLoginOption(fakeIm)

	expect(fakeIm.session.setModel).toHaveBeenCalledWith({
		id: "other-model",
		provider: "kimchi-dev",
	})
	expect(getFeedbackMessages(fakeIm)).toContainEqual(
		expect.stringContaining("Logged in to Kimchi. Selected other-model. Credentials saved to "),
	)
})

it("reports failure when no models are available for the provider", async () => {
	const cliAuthModule = await import("./cli-auth/index.js")
	vi.spyOn(cliAuthModule, "authenticateViaBrowser").mockResolvedValue({
		token: "test-token-789",
	})

	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockReturnValue([])

	const fakeIm = makeFakeInteractiveMode(registry)
	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectCurrentLoginOption(fakeIm)

	expect(fakeIm.showError).toHaveBeenCalledWith(
		"Kimchi login did not configure any available models. Your API key was saved; try again.",
	)
	expect(getFeedbackMessages(fakeIm)).not.toContain("✓ Login successful. API key saved.")
	expect(fakeIm.session.setModel).not.toHaveBeenCalled()
})

it("shows error when browser auth fails", async () => {
	const cliAuthModule = await import("./cli-auth/index.js")
	vi.spyOn(cliAuthModule, "authenticateViaBrowser").mockRejectedValue(new Error("Browser closed"))

	const registry = makeFakeModelRegistry()
	const fakeIm = makeFakeInteractiveMode(registry)
	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectCurrentLoginOption(fakeIm)

	expect(fakeIm.showError).toHaveBeenCalledWith("Kimchi login failed: Browser closed")
	expect(registry.authStorage.set).not.toHaveBeenCalled()
})

it("prompts for Kimchi API key and endpoint with the default endpoint", async () => {
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "/tmp/kimchi-api-login-test")

	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockReturnValue([{ id: "kimi-k2.6", provider: "kimchi-dev" }])

	const fakeIm = makeFakeInteractiveMode(registry)
	fakeIm.showExtensionInput.mockResolvedValueOnce("api-key-123").mockResolvedValueOnce("")

	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectApiKeyLoginOption(fakeIm)
	await waitForMockCall(fakeIm.session.setModel)

	expect(fakeIm.showExtensionInput).toHaveBeenNthCalledWith(1, "Kimchi API Key:", "Enter your Kimchi API key")
	expect(fakeIm.showExtensionInput).toHaveBeenNthCalledWith(
		2,
		"Kimchi endpoint (press Enter to use https://llm.kimchi.dev):",
		"",
	)
	expect(fakeIm.showStatus).toHaveBeenCalledWith("Refreshing Kimchi models from https://llm.kimchi.dev...")
	expect(configModule.writeApiKey).toHaveBeenCalledWith("api-key-123", undefined, {
		llmEndpoint: "https://llm.kimchi.dev",
	})
	expect(modelsModule.updateModelsConfig).toHaveBeenCalledWith(
		"/tmp/kimchi-api-login-test/models.json",
		"api-key-123",
		{
			allowCachedFallback: false,
			endpoint: "https://llm.kimchi.dev",
		},
	)
	expect(registry.authStorage.set).toHaveBeenCalledWith("kimchi-dev", {
		type: "api_key",
		key: "api-key-123",
	})
	expect(fakeIm.session.setModel).toHaveBeenCalledWith({
		id: "kimi-k2.6",
		provider: "kimchi-dev",
	})
})

it("uses a custom Kimchi endpoint for API-key model discovery and config persistence", async () => {
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "/tmp/kimchi-api-login-test")

	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockReturnValue([{ id: "custom-model", provider: "kimchi-dev" }])

	const fakeIm = makeFakeInteractiveMode(registry)
	fakeIm.showExtensionInput.mockResolvedValueOnce(" api-key-456 ").mockResolvedValueOnce(" https://custom.example/ ")

	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectApiKeyLoginOption(fakeIm)
	await waitForMockCall(fakeIm.session.setModel)

	expect(fakeIm.showStatus).toHaveBeenCalledWith("Refreshing Kimchi models from https://custom.example/...")
	expect(modelsModule.updateModelsConfig).toHaveBeenCalledWith(
		"/tmp/kimchi-api-login-test/models.json",
		"api-key-456",
		{
			allowCachedFallback: false,
			endpoint: "https://custom.example/",
		},
	)
	expect(configModule.writeApiKey).toHaveBeenCalledWith("api-key-456", undefined, {
		llmEndpoint: "https://custom.example/",
	})
	expect(registry.authStorage.set).toHaveBeenCalledWith("kimchi-dev", {
		type: "api_key",
		key: "api-key-456",
	})
	expect(fakeIm.session.setModel).toHaveBeenCalledWith({ id: "custom-model", provider: "kimchi-dev" })
})

it("does not persist API-key login when model discovery rejects an invalid key", async () => {
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "/tmp/kimchi-api-login-test")
	vi.mocked(modelsModule.updateModelsConfig).mockRejectedValueOnce(
		new modelsModule.ModelsFetchError("Failed to fetch models: 401 Unauthorized", {
			status: 401,
			transient: false,
		}),
	)

	const registry = makeFakeModelRegistry()
	const fakeIm = makeFakeInteractiveMode(registry)
	fakeIm.showExtensionInput.mockResolvedValueOnce("bad-key").mockResolvedValueOnce("https://llm.kimchi.dev")

	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectApiKeyLoginOption(fakeIm)
	await waitForMockCall(fakeIm.showError)

	expect(fakeIm.showError).toHaveBeenCalledWith(
		"Invalid API key. Please check your key and try again. No changes were saved.",
	)
	expect(configModule.writeApiKey).not.toHaveBeenCalled()
	expect(registry.authStorage.set).not.toHaveBeenCalled()
	expect(registry.authStorage.remove).not.toHaveBeenCalled()
	expect(registry.refresh).not.toHaveBeenCalled()
	expect(fakeIm.session.setModel).not.toHaveBeenCalled()
})

it("does not persist API-key login when the endpoint is unreachable", async () => {
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "/tmp/kimchi-api-login-test")
	vi.mocked(modelsModule.updateModelsConfig).mockRejectedValueOnce(
		new modelsModule.ModelsFetchError("Failed to fetch models: network down", { transient: true }),
	)

	const registry = makeFakeModelRegistry()
	const fakeIm = makeFakeInteractiveMode(registry)
	fakeIm.showExtensionInput.mockResolvedValueOnce("api-key-123").mockResolvedValueOnce("https://offline.example")

	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectApiKeyLoginOption(fakeIm)
	await waitForMockCall(fakeIm.showError)

	expect(fakeIm.showError).toHaveBeenCalledWith(
		"Kimchi endpoint is unreachable or temporarily unavailable (Failed to fetch models: network down). Check the endpoint and try again. No changes were saved.",
	)
	expect(configModule.writeApiKey).not.toHaveBeenCalled()
	expect(registry.authStorage.set).not.toHaveBeenCalled()
	expect(registry.authStorage.remove).not.toHaveBeenCalled()
	expect(registry.refresh).not.toHaveBeenCalled()
	expect(fakeIm.session.setModel).not.toHaveBeenCalled()
})

it("rolls back API-key auth when fresh discovery succeeds but no Kimchi models become available", async () => {
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "/tmp/kimchi-api-login-test")

	const previousCredential = { type: "api_key", key: "previous-key" }
	const registry = makeFakeModelRegistry()
	registry.authStorage.get.mockReturnValue(previousCredential)
	registry.getAvailable.mockReturnValue([{ id: "gpt-4", provider: "openai" }])

	const fakeIm = makeFakeInteractiveMode(registry)
	fakeIm.showExtensionInput.mockResolvedValueOnce("api-key-123").mockResolvedValueOnce("https://llm.kimchi.dev")

	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectApiKeyLoginOption(fakeIm)
	await waitForMockCall(fakeIm.showError)

	expect(fakeIm.showError).toHaveBeenCalledWith(
		"Kimchi API-key login found no available Kimchi models. No changes were saved.",
	)
	expect(registry.authStorage.set).toHaveBeenNthCalledWith(1, "kimchi-dev", {
		type: "api_key",
		key: "api-key-123",
	})
	expect(registry.authStorage.set).toHaveBeenNthCalledWith(2, "kimchi-dev", previousCredential)
	expect(configModule.writeApiKey).not.toHaveBeenCalled()
	expect(fakeIm.session.setModel).not.toHaveBeenCalled()
})

it("routes the subscription option to upstream OAuth providers without showing Kimchi as a duplicate", async () => {
	const registry = makeFakeModelRegistry()
	const fakeIm = makeFakeInteractiveMode(registry)
	fakeIm.getLoginProviderOptions.mockReturnValue([
		{ id: "kimchi-dev", name: "Kimchi", authType: "oauth" },
		{ id: "anthropic", name: "Claude", authType: "oauth" },
	])

	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectSubscriptionLoginOption(fakeIm)
	fakeIm.selectorComponent.handleInput("\n")
	await waitForMockCall(fakeIm.showLoginDialog)

	expect(fakeIm.getLoginProviderOptions).toHaveBeenCalledWith("oauth")
	expect(fakeIm.showLoginDialog).toHaveBeenCalledWith("anthropic", "Claude")
})

it("pre-populates subscription provider models in models.json before upstream login", async () => {
	const piAi = await import("@earendil-works/pi-ai")
	const getModelsMock = vi.mocked(piAi.getModels)
	getModelsMock.mockReturnValue([
		{
			id: "codex",
			name: "Codex",
			provider: "openai",
			api: "openai-chat",
			baseUrl: "https://api.openai.com/v1/chat/completions",
			input: ["text"],
			contextWindow: 200000,
			maxTokens: 8192,
			reasoning: false,
			cost: { input: 3, output: 12, cacheRead: 0, cacheWrite: 0 },
		},
	] as ReturnType<typeof getModelsMock>)

	const modelsModule = await import("./models.js")
	const syncSpy = vi.spyOn(modelsModule, "syncProviderModels").mockImplementation(() => {})

	const registry = makeFakeModelRegistry()
	const fakeIm = makeFakeInteractiveMode(registry)
	fakeIm.getLoginProviderOptions.mockReturnValue([{ id: "openai", name: "OpenAI", authType: "oauth" }])

	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "/tmp/kimchi-test-models")

	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectSubscriptionLoginOption(fakeIm)
	fakeIm.selectorComponent.handleInput("\n")
	await waitForMockCall(fakeIm.showLoginDialog)

	expect(fakeIm.showLoginDialog).toHaveBeenCalledWith("openai", "OpenAI")
	expect(syncSpy).toHaveBeenCalledOnce()
	const [_path, providerId, configs, providerConfig] = syncSpy.mock.calls[0] as unknown as [
		string,
		string,
		unknown[],
		unknown,
	]
	expect(providerId).toBe("openai")
	expect(providerConfig).toMatchObject({
		api: "openai-chat",
		baseUrl: "https://api.openai.com/v1/chat/completions",
	})
	expect(configs).toHaveLength(1)
	expect(configs[0]).toMatchObject({
		id: "codex",
		name: "Codex",
		provider: "openai",
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 8192,
		reasoning: false,
	})
	syncSpy.mockRestore()
	getModelsMock.mockReturnValue([])
})

it("does not crash when registry.getAvailable returns empty after subscription login", async () => {
	const modelsModule = await import("./models.js")
	const syncSpy = vi.spyOn(modelsModule, "syncProviderModels").mockImplementation(() => {})

	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockResolvedValue([])

	const fakeIm = makeFakeInteractiveMode(registry)
	fakeIm.getLoginProviderOptions.mockReturnValue([{ id: "openai", name: "OpenAI", authType: "oauth" }])

	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectSubscriptionLoginOption(fakeIm)
	fakeIm.selectorComponent.handleInput("\n")
	await waitForMockCall(fakeIm.showLoginDialog)

	expect(fakeIm.showLoginDialog).toHaveBeenCalled()
	expect(syncSpy).not.toHaveBeenCalled()

	syncSpy.mockRestore()
})

it("does not crash when registry.getAvailable throws after subscription login", async () => {
	const modelsModule = await import("./models.js")
	const syncSpy = vi.spyOn(modelsModule, "syncProviderModels").mockImplementation(() => {})

	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockRejectedValue(new Error("registry unavailable"))

	const fakeIm = makeFakeInteractiveMode(registry)
	fakeIm.getLoginProviderOptions.mockReturnValue([{ id: "openai", name: "OpenAI", authType: "oauth" }])

	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectSubscriptionLoginOption(fakeIm)
	fakeIm.selectorComponent.handleInput("\n")
	await waitForMockCall(fakeIm.showLoginDialog)

	expect(fakeIm.showLoginDialog).toHaveBeenCalled()
	expect(syncSpy).not.toHaveBeenCalled()

	syncSpy.mockRestore()
})

it("passes through to original showOAuthSelector for 'logout' mode", async () => {
	// Stub oauthDelegate.original so the logout delegation path is exercised
	// without calling into the real upstream implementation (which requires a
	// fully constructed InteractiveMode with private methods).
	const stub = vi.fn().mockResolvedValue(undefined)
	const saved = oauthDelegate.original
	oauthDelegate.original = stub

	try {
		const fakeIm = makeFakeInteractiveMode(makeFakeModelRegistry())
		// biome-ignore lint/suspicious/noExplicitAny: not present in public type
		const patched = (InteractiveMode.prototype as any).showOAuthSelector
		await patched.call(fakeIm, "logout")
		expect(stub).toHaveBeenCalledOnce()
		expect(stub).toHaveBeenCalledWith("logout")
	} finally {
		oauthDelegate.original = saved
	}
})

it("suppresses stale startup no-model warning after startup auth selected a model", () => {
	const stub = vi.fn()
	const saved = warningDelegate.original
	warningDelegate.original = stub

	try {
		const fakeIm = makeFakeInteractiveMode(makeFakeModelRegistry())
		fakeIm.session.model = { id: "kimi-k2.6", provider: "kimchi-dev" }

		// biome-ignore lint/suspicious/noExplicitAny: not present in public type
		const patched = (InteractiveMode.prototype as any).showWarning
		patched.call(fakeIm, "No models available. Use /login to log into a provider via OAuth or API key.")

		expect(stub).not.toHaveBeenCalled()
	} finally {
		warningDelegate.original = saved
	}
})

it("keeps real no-model warnings when no model became available", () => {
	const stub = vi.fn()
	const saved = warningDelegate.original
	warningDelegate.original = stub

	try {
		const fakeIm = makeFakeInteractiveMode(makeFakeModelRegistry())

		// biome-ignore lint/suspicious/noExplicitAny: not present in public type
		const patched = (InteractiveMode.prototype as any).showWarning
		patched.call(fakeIm, "No models available. Use /login to log into a provider via OAuth or API key.")

		expect(stub).toHaveBeenCalledOnce()
	} finally {
		warningDelegate.original = saved
	}
})
