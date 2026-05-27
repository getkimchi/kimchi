import { getModels } from "@earendil-works/pi-ai"
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as loginPatch from "./login-command-patch.js"

const { applyLoginCommandPatch, oauthDelegate } = loginPatch

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

let originalCodingAgentDir: string | undefined

beforeEach(() => {
	originalCodingAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
})

afterEach(() => {
	if (originalCodingAgentDir === undefined) {
		// biome-ignore lint/performance/noDelete: process.env requires delete operator to be truly unset rather than stringified to "undefined"
		delete process.env.KIMCHI_CODING_AGENT_DIR
	} else {
		process.env.KIMCHI_CODING_AGENT_DIR = originalCodingAgentDir
	}
	vi.restoreAllMocks()
	vi.mocked(getModels).mockReturnValue([])
})

function makeFakeModelRegistry() {
	return {
		authStorage: {
			set: vi.fn(),
			get: vi.fn(),
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

async function selectSubscriptionLoginOption(fakeIm: FakeIm): Promise<void> {
	fakeIm.selectorComponent.handleInput("j")
	fakeIm.selectorComponent.handleInput("\n")
	await Promise.resolve()
}

it("intercepts showOAuthSelector('login') and runs Kimchi browser auth", async () => {
	const cliAuthModule = await import("./cli-auth/index.js")
	const authSpy = vi.spyOn(cliAuthModule, "authenticateViaBrowser").mockResolvedValue({ token: "test-token-123" })
	const configModule = await import("./config.js")
	vi.spyOn(configModule, "writeApiKey").mockImplementation(() => {})

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
	expect(getFeedbackMessages(fakeIm)).toContain("✓ Logged in. Model: kimi-k2.6")
})

it("falls back to the first available model when the default is not present", async () => {
	const cliAuthModule = await import("./cli-auth/index.js")
	vi.spyOn(cliAuthModule, "authenticateViaBrowser").mockResolvedValue({
		token: "test-token-456",
	})
	const configModule = await import("./config.js")
	vi.spyOn(configModule, "writeApiKey").mockImplementation(() => {})

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
	expect(getFeedbackMessages(fakeIm)).toContain("✓ Logged in. Model: other-model")
})

it("shows generic success when no models are available for the provider", async () => {
	const cliAuthModule = await import("./cli-auth/index.js")
	vi.spyOn(cliAuthModule, "authenticateViaBrowser").mockResolvedValue({
		token: "test-token-789",
	})
	const configModule = await import("./config.js")
	vi.spyOn(configModule, "writeApiKey").mockImplementation(() => {})

	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockReturnValue([])

	const fakeIm = makeFakeInteractiveMode(registry)
	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")
	await selectCurrentLoginOption(fakeIm)

	expect(getFeedbackMessages(fakeIm)).toContain("✓ Login successful. API key saved.")
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

	const previousDir = process.env.KIMCHI_CODING_AGENT_DIR
	process.env.KIMCHI_CODING_AGENT_DIR = "/tmp/kimchi-test-models"

	try {
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
	} finally {
		if (previousDir === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete operator to be truly unset rather than stringified to "undefined"
			delete process.env.KIMCHI_CODING_AGENT_DIR
		} else {
			process.env.KIMCHI_CODING_AGENT_DIR = previousDir
		}
		syncSpy.mockRestore()
		getModelsMock.mockReturnValue([])
	}
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
