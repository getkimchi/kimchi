import { LoginDialogComponent, type Theme, initTheme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const authMock = vi.hoisted(() => ({
	authenticateViaBrowser: vi.fn(),
}))

const configMock = vi.hoisted(() => ({
	loadConfig: vi.fn(),
	writeApiKey: vi.fn(),
}))

const modelsMock = vi.hoisted(() => ({
	updateModelsConfig: vi.fn(),
	syncProviderModels: vi.fn(),
	isTransientModelsError: vi.fn((error: unknown) => (error as { transient?: boolean })?.transient === true),
}))

vi.mock("../../cli-auth/index.js", () => authMock)
vi.mock("../../config.js", () => configMock)
vi.mock("../../models.js", () => modelsMock)

import {
	type StartupAuthGateState,
	createStartupAuthGate,
	createStartupAuthGateState,
	shouldShowStartupAuthGate,
} from "./startup-auth.js"

type SessionStartHandler = (event: { reason: string }, ctx: unknown) => unknown
type TerminalInputHandler = (data: string) => unknown
type CustomComponent = { handleInput?(data: string): void }

function theme(): Theme {
	return {
		fg: vi.fn((_color: string, text: string) => text),
		bg: vi.fn((_color: string, text: string) => text),
		bold: vi.fn((text: string) => text),
		getFgAnsi: vi.fn(),
		getBgAnsi: vi.fn(),
		fgColors: {},
		bgColors: {},
		mode: "dark",
		preproc: vi.fn(),
		extensions: {},
	} as unknown as Theme
}

function createHarness(
	options: {
		state?: StartupAuthGateState
		availableInitially?: boolean
		addModelOnAuthSet?: boolean
		overlayActiveInitially?: boolean
		onCancel?: ReturnType<typeof vi.fn>
		afterSessionStart?: SessionStartHandler
	} = {},
) {
	const handlers = new Map<string, SessionStartHandler[]>()
	const api = {
		on: vi.fn((event: string, handler: SessionStartHandler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		}),
		setModel: vi.fn().mockResolvedValue(true),
	}
	const availableModels: Array<{ id: string; provider: string }> = options.availableInitially
		? [{ id: "kimi-k2.6", provider: "kimchi-dev" }]
		: []
	const authStorage = {
		set: vi.fn((provider: string) => {
			if (provider === "kimchi-dev" && options.addModelOnAuthSet !== false && availableModels.length === 0) {
				availableModels.push({ id: "kimi-k2.6", provider: "kimchi-dev" })
			}
		}),
		get: vi.fn(),
		getOAuthProviders: vi.fn(() => []),
		login: vi.fn(),
	}
	const modelRegistry = {
		authStorage,
		refresh: vi.fn(),
		getAvailable: vi.fn(() => availableModels),
		getProviderAuthStatus: vi.fn(() => ({ configured: false })),
	}
	let activeComponent: CustomComponent | undefined
	let overlayActive = options.overlayActiveInitially === true
	let terminalInputHandler: TerminalInputHandler | undefined
	const tui = { requestRender: vi.fn(), hasOverlay: vi.fn(() => overlayActive) } as unknown as TUI
	const ui = {
		setWidget: vi.fn((_key: string, content: unknown) => {
			if (typeof content === "function") content(tui, theme())
		}),
		onTerminalInput: vi.fn((handler: TerminalInputHandler) => {
			terminalInputHandler = handler
			return () => {
				if (terminalInputHandler === handler) terminalInputHandler = undefined
			}
		}),
		custom: vi.fn((factory: (...args: unknown[]) => CustomComponent) => {
			return new Promise((resolve) => {
				const done = (result: unknown) => {
					activeComponent = undefined
					resolve(result)
				}
				activeComponent = factory(tui, theme(), {}, done)
			})
		}),
		notify: vi.fn(),
		input: vi.fn(),
	}
	const ctx = { hasUI: true, ui, modelRegistry }
	const state = options.state ?? createStartupAuthGateState()

	createStartupAuthGate({
		nonInteractiveMode: false,
		stdinIsTTY: true,
		stdoutIsTTY: true,
		state,
		onCancel: options.onCancel,
	})(api as never)
	if (options.afterSessionStart) api.on("session_start", options.afterSessionStart)

	return {
		api,
		ctx,
		modelRegistry,
		state,
		setOverlay: (active: boolean) => {
			overlayActive = active
		},
		start: async () => {
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ reason: "startup" }, ctx)
			}
		},
		input: (data: string) => activeComponent?.handleInput?.(data),
		terminalInput: (data: string) => terminalInputHandler?.(data),
		settle: async () => {
			for (let i = 0; i < 4; i += 1) await Promise.resolve()
		},
		waitForCustomPrompts: async (count: number) => {
			for (let i = 0; i < 50; i += 1) {
				if (ui.custom.mock.calls.length >= count) return
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
			throw new Error(`Timed out waiting for ${count} auth prompts`)
		},
	}
}

beforeAll(() => {
	initTheme("default")
})

beforeEach(() => {
	authMock.authenticateViaBrowser.mockReset()
	authMock.authenticateViaBrowser.mockResolvedValue({ token: "kimchi-token" })
	let savedConfigKey = ""
	configMock.loadConfig.mockReset()
	configMock.loadConfig.mockImplementation(() => ({ apiKey: savedConfigKey }))
	configMock.writeApiKey.mockReset()
	configMock.writeApiKey.mockImplementation((key: string) => {
		savedConfigKey = key
	})
	modelsMock.updateModelsConfig.mockReset()
	modelsMock.updateModelsConfig.mockResolvedValue({ models: [] })
	modelsMock.syncProviderModels.mockReset()
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("shouldShowStartupAuthGate", () => {
	it("shows for an unauthenticated interactive startup", () => {
		expect(
			shouldShowStartupAuthGate({
				hasUI: true,
				stdinIsTTY: true,
				stdoutIsTTY: true,
				nonInteractiveMode: false,
				sessionStartReason: "startup",
				hasUsableAuth: false,
			}),
		).toBe(true)
	})

	it("skips once usable auth is available", () => {
		expect(
			shouldShowStartupAuthGate({
				hasUI: true,
				stdinIsTTY: true,
				stdoutIsTTY: true,
				nonInteractiveMode: false,
				sessionStartReason: "startup",
				hasUsableAuth: true,
			}),
		).toBe(false)
	})
})

describe("startup auth gate", () => {
	it("runs the shared Kimchi login option and selects the configured model", async () => {
		const harness = createHarness()
		const started = harness.start()

		await harness.settle()
		harness.input("\n")
		await started

		expect(authMock.authenticateViaBrowser).toHaveBeenCalledOnce()
		expect(configMock.writeApiKey).toHaveBeenCalledWith("kimchi-token")
		expect(harness.modelRegistry.authStorage.set).toHaveBeenCalledWith("kimchi-dev", {
			type: "api_key",
			key: "kimchi-token",
		})
		expect(harness.api.setModel).toHaveBeenCalledWith({ id: "kimi-k2.6", provider: "kimchi-dev" })
		expect(harness.state.authenticated).toBe(true)
	})

	it("surfaces the login URL in pi's login dialog so it can be copied into the right browser/profile", async () => {
		const loginUrl = "https://app.kimchi.dev/cli-auth?callback=http%3A%2F%2Flocalhost%3A51234&state=abc123"
		authMock.authenticateViaBrowser.mockImplementation(async (options: { onBrowserUrl?: (url: string) => void }) => {
			options?.onBrowserUrl?.(loginUrl)
			return { token: "kimchi-token" }
		})
		// The URL is shown via the reused LoginDialogComponent's showInfo, not notify.
		const showInfoSpy = vi.spyOn(LoginDialogComponent.prototype, "showInfo")

		try {
			const harness = createHarness()
			const started = harness.start()

			await harness.settle()
			harness.input("\n")
			await started

			expect(authMock.authenticateViaBrowser).toHaveBeenCalledOnce()
			const lines = showInfoSpy.mock.calls.flatMap((call) => call[0] as string[])
			// Intact BEL-terminated OSC 8 hyperlink target so "Copy Link" yields the full
			// URL even when the visible text wraps (a raw wrapped URL would get a newline
			// injected at the wrap point, corrupting the state param on paste). The `id=`
			// param groups the wrapped rows so the whole URL highlights as one link.
			expect(lines.some((line) => line.includes(`;${loginUrl}\x07`))).toBe(true)
			expect(lines.some((line) => line.includes("\x1b]8;id=kimchi-login-"))).toBe(true)
		} finally {
			showInfoSpy.mockRestore()
		}
	})

	it("cancels the Kimchi login dialog without showing a login failure", async () => {
		authMock.authenticateViaBrowser.mockImplementation(
			(options: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(new Error("Browser login failed: Login cancelled")), {
						once: true,
					})
				}),
		)

		const onCancel = vi.fn()
		const harness = createHarness({ onCancel })
		const started = harness.start()

		await harness.settle()
		harness.input("\n")
		await harness.waitForCustomPrompts(2)

		harness.input("\x1b")
		await harness.waitForCustomPrompts(3)

		expect(authMock.authenticateViaBrowser).toHaveBeenCalledOnce()
		expect(harness.ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Kimchi login failed"), "error")
		expect(harness.ctx.ui.notify).not.toHaveBeenCalledWith(
			"Login did not configure an available model. Try again or cancel.",
			"warning",
		)

		harness.input("\x1b")
		await started

		expect(harness.state.cancelled).toBe(true)
		expect(onCancel).toHaveBeenCalledOnce()
	})

	it("does not mint another browser key when a retry still has no available models", async () => {
		const previousAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		process.env.KIMCHI_CODING_AGENT_DIR = "/tmp/kimchi-startup-auth-test"
		let savedConfigKey = ""
		configMock.loadConfig.mockImplementation(() => ({ apiKey: savedConfigKey }))
		configMock.writeApiKey.mockImplementation((key: string) => {
			savedConfigKey = key
		})
		const onCancel = vi.fn()
		const harness = createHarness({ addModelOnAuthSet: false, onCancel })

		try {
			const started = harness.start()

			// Each Kimchi attempt opens two customs: the auth-method selector, then the
			// login dialog. So selectors land on prompts #1, #3, #5 (dialogs are #2, #4).
			await harness.settle()
			harness.input("\n")
			await harness.waitForCustomPrompts(3)
			harness.input("\n")
			await harness.waitForCustomPrompts(5)
			harness.input("\x1b")
			await started

			expect(authMock.authenticateViaBrowser).toHaveBeenCalledOnce()
			expect(modelsMock.updateModelsConfig).toHaveBeenCalledTimes(2)
			expect(modelsMock.updateModelsConfig.mock.calls.map((call) => call[1])).toEqual(["kimchi-token", "kimchi-token"])
			expect(harness.state.authenticated).toBe(false)
			expect(harness.state.cancelled).toBe(true)
		} finally {
			if (previousAgentDir === undefined) {
				// biome-ignore lint/performance/noDelete: process.env requires delete operator to be truly unset rather than stringified to "undefined"
				delete process.env.KIMCHI_CODING_AGENT_DIR
			} else {
				process.env.KIMCHI_CODING_AGENT_DIR = previousAgentDir
			}
		}
	})

	it("reports a transient rate-limit failure as retryable without discarding the saved key", async () => {
		const previousAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		process.env.KIMCHI_CODING_AGENT_DIR = "/tmp/kimchi-startup-auth-test"
		let savedConfigKey = ""
		configMock.loadConfig.mockImplementation(() => ({ apiKey: savedConfigKey }))
		configMock.writeApiKey.mockImplementation((key: string) => {
			savedConfigKey = key
		})
		const transientError = Object.assign(new Error("Failed to fetch models: 429 Too Many Requests"), {
			transient: true,
		})
		modelsMock.updateModelsConfig.mockRejectedValue(transientError)
		const onCancel = vi.fn()
		const harness = createHarness({ addModelOnAuthSet: false, onCancel })

		try {
			const started = harness.start()

			await harness.settle()
			harness.input("\n")
			await harness.waitForCustomPrompts(2)
			harness.input("\x1b")
			await started

			// The browser flow ran once; the retry reused the saved key (no new mint).
			expect(authMock.authenticateViaBrowser).toHaveBeenCalledOnce()
			const messages = (harness.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])
			expect(messages.some((message: string) => /temporarily unavailable/i.test(message))).toBe(true)
			expect(harness.state.authenticated).toBe(false)
			expect(harness.state.cancelled).toBe(true)
		} finally {
			if (previousAgentDir === undefined) {
				// biome-ignore lint/performance/noDelete: process.env requires delete operator to be truly unset rather than stringified to "undefined"
				delete process.env.KIMCHI_CODING_AGENT_DIR
			} else {
				process.env.KIMCHI_CODING_AGENT_DIR = previousAgentDir
			}
		}
	})

	it("keeps later startup onboarding parked while authentication is pending", async () => {
		const laterOnboarding = vi.fn()
		const onCancel = vi.fn()
		const harness = createHarness({ afterSessionStart: laterOnboarding, onCancel })

		const started = harness.start()

		await harness.settle()
		expect(laterOnboarding).not.toHaveBeenCalled()

		harness.input("\x1b")
		await started

		expect(laterOnboarding).toHaveBeenCalledOnce()
	})

	it("waits for an active overlay before showing the login selector", async () => {
		const harness = createHarness({ overlayActiveInitially: true })
		const started = harness.start()

		await harness.settle()

		expect(harness.ctx.ui.custom).not.toHaveBeenCalled()
		expect(harness.modelRegistry.authStorage.set).not.toHaveBeenCalled()

		harness.setOverlay(false)
		harness.terminalInput("x")
		await harness.waitForCustomPrompts(1)

		expect(harness.ctx.ui.custom).toHaveBeenCalledOnce()

		harness.input("\n")
		await started

		expect(authMock.authenticateViaBrowser).toHaveBeenCalledOnce()
		expect(harness.state.authenticated).toBe(true)
	})

	it("does not show the selector when auth is already usable", async () => {
		configMock.loadConfig.mockReturnValue({ apiKey: "saved-config-token" })
		const harness = createHarness({ availableInitially: true })

		await harness.start()

		expect(harness.ctx.ui.custom).not.toHaveBeenCalled()
		expect(harness.state.attempted).toBe(false)
	})

	it("does not treat cached Kimchi models as usable without a saved key", async () => {
		const onCancel = vi.fn()
		const harness = createHarness({ availableInitially: true, onCancel })
		const started = harness.start()

		await harness.waitForCustomPrompts(1)
		harness.input("\x1b")
		await started

		expect(harness.ctx.ui.custom).toHaveBeenCalledOnce()
		expect(harness.state.cancelled).toBe(true)
		expect(onCancel).toHaveBeenCalledWith(harness.ctx)
	})

	it("preserves master behavior by seeding saved config keys as oauth credentials", async () => {
		configMock.loadConfig.mockReturnValue({ apiKey: "saved-config-token" })
		const harness = createHarness()

		await harness.start()

		expect(harness.modelRegistry.authStorage.set).toHaveBeenCalledWith("kimchi-dev", {
			type: "oauth",
			access: "saved-config-token",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		})
		expect(harness.ctx.ui.custom).not.toHaveBeenCalled()
	})

	it("marks cancellation and delegates shutdown behavior to the caller", async () => {
		const onCancel = vi.fn()
		const harness = createHarness({ onCancel })
		const started = harness.start()

		await harness.settle()
		harness.input("\x1b")
		await started

		expect(harness.state.cancelled).toBe(true)
		expect(onCancel).toHaveBeenCalledWith(harness.ctx)
	})

	it("runs the API key login option and authenticates with a custom endpoint", async () => {
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "/tmp/kimchi-startup-auth-test")
		const harness = createHarness()

		// Simulate user providing API key and custom endpoint via ctx.ui.input
		harness.ctx.ui.input.mockResolvedValueOnce("my-api-key").mockResolvedValueOnce("https://custom.kimchi.example")

		modelsMock.updateModelsConfig.mockResolvedValue({ models: [{ slug: "kimi-k2.6", provider: "ai-enabler" }] })

		const started = harness.start()
		await harness.settle()

		// Select the API key option (second item: j then Enter)
		harness.input("j")
		harness.input("\n")

		await started

		expect(harness.ctx.ui.input).toHaveBeenNthCalledWith(1, "Kimchi API Key:")
		expect(harness.ctx.ui.input).toHaveBeenNthCalledWith(
			2,
			"Kimchi endpoint (press Enter to use https://llm.kimchi.dev):",
		)
		expect(modelsMock.updateModelsConfig).toHaveBeenCalledWith(
			expect.stringContaining("models.json"),
			"my-api-key",
			expect.objectContaining({ endpoint: "https://custom.kimchi.example" }),
		)
		expect(harness.state.authenticated).toBe(true)
	})

	it("cancels API key login when the user dismisses the API key input", async () => {
		const onCancel = vi.fn().mockResolvedValue(undefined)
		const harness = createHarness({ onCancel })
		harness.ctx.ui.input.mockResolvedValueOnce(undefined) // user pressed Escape

		const started = harness.start()
		await harness.settle()

		// Select API key option
		harness.input("j")
		harness.input("\n")

		// After cancellation the gate loops back to the selector — cancel it
		await harness.waitForCustomPrompts(2)
		harness.input("\x1b")
		await started

		expect(harness.state.cancelled).toBe(true)
		expect(modelsMock.updateModelsConfig).not.toHaveBeenCalled()
	})
})
