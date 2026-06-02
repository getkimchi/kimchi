import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { globalTipRegistry } from "../tips/registry.js"
import sessionModeOnboardingExtension, {
	buildSessionModeLaunchContext,
	decideSessionModeOnboarding,
	recordSessionModeWizardOutcome,
	type SessionModeLaunchContext,
	type SessionModeOnboardingDecision,
} from "./session-mode.js"

const interactive = { stdinIsTTY: true, stdoutIsTTY: true, nonInteractiveMode: false }

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

function launch(rawArgs: string[], overrides: Partial<typeof interactive> = {}): SessionModeLaunchContext {
	return buildSessionModeLaunchContext(rawArgs, { ...interactive, ...overrides })
}

function decide(
	rawArgs: string[],
	overrides: Partial<Parameters<typeof decideSessionModeOnboarding>[0]> = {},
): SessionModeOnboardingDecision {
	return decideSessionModeOnboarding({
		launchContext: launch(rawArgs),
		hasUI: true,
		sessionStartReason: "startup",
		...overrides,
	})
}

type SessionStartHandler = (event: unknown, ctx: unknown) => unknown
type TerminalInputHandler = (data: string) => { consume?: boolean } | undefined
type CustomComponent = { handleInput?(data: string): void; render?(width: number): string[] }
const extensionHarnesses: Array<{ shutdown: () => unknown; settle: () => Promise<void> }> = []

function createExtensionHarness(options: { deferCustomFactory?: boolean; initialEditorFactory?: unknown } = {}) {
	const handlers = new Map<string, SessionStartHandler>()
	const api = {
		on: vi.fn((event: string, handler: SessionStartHandler) => {
			handlers.set(event, handler)
		}),
	}
	let overlayActive = false
	const setOverlay = (active: boolean) => {
		overlayActive = active
	}
	const tui = {
		requestRender: vi.fn(),
		hasOverlay: vi.fn(() => overlayActive),
	} as unknown as TUI
	let activeComponent: CustomComponent | undefined
	let inputHandler: TerminalInputHandler | undefined
	const unsubscribe = vi.fn()
	let storedEditorFactory: unknown = options.initialEditorFactory
	const ui = {
		setWidget: vi.fn((_key: string, content: unknown, _options?: unknown) => {
			if (typeof content === "function") {
				activeComponent = content(tui, theme()) as CustomComponent
			} else {
				activeComponent = undefined
			}
		}),
		onTerminalInput: vi.fn((handler: TerminalInputHandler) => {
			inputHandler = handler
			return unsubscribe
		}),
		getEditorComponent: vi.fn(() => storedEditorFactory),
		setEditorComponent: vi.fn((factory: unknown) => {
			storedEditorFactory = factory
		}),
		custom: vi.fn((factory: (...args: unknown[]) => CustomComponent | Promise<CustomComponent>) => {
			return new Promise((resolve, reject) => {
				let doneCalled = false
				const done = (result: unknown) => {
					if (doneCalled) return
					doneCalled = true
					activeComponent = undefined
					resolve(result)
				}
				const mount = () => {
					const content = factory(tui, theme(), {}, done)
					if (content && typeof (content as Promise<CustomComponent>).then === "function") {
						;(content as Promise<CustomComponent>).then((component) => {
							if (!doneCalled) activeComponent = component
						}, reject)
					} else if (!doneCalled) {
						activeComponent = content as CustomComponent
					}
				}
				try {
					if (options.deferCustomFactory === true) {
						void Promise.resolve().then(mount).catch(reject)
					} else {
						mount()
					}
				} catch (err) {
					reject(err)
				}
			})
		}),
		notify: vi.fn(),
	}
	const ctx = { hasUI: true, ui }
	const harness = {
		api,
		ui,
		tui,
		unsubscribe,
		start: () => handlers.get("session_start")?.({ reason: "startup" }, ctx),
		shutdown: () => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx),
		input: (data: string) => inputHandler?.(data) ?? activeComponent?.handleInput?.(data),
		activeComponent: () => activeComponent,
		setOverlay,
		settle: async () => {
			for (let i = 0; i < 4; i += 1) await Promise.resolve()
		},
	}
	extensionHarnesses.push(harness)
	return harness
}

afterEach(async () => {
	for (const harness of extensionHarnesses.splice(0)) {
		harness.shutdown()
		await harness.settle()
	}
	globalTipRegistry.clear()
})

describe("buildSessionModeLaunchContext", () => {
	it("classifies a plain interactive launch as eligible launch context", () => {
		expect(launch([])).toEqual({
			stdinIsTTY: true,
			stdoutIsTTY: true,
			nonInteractiveMode: false,
			explicitSession: false,
			explicitDefaultIntent: false,
		})
	})

	it.each([
		{ args: ["fix tests"], label: "initial CLI message" },
		{ args: ["@prompt.md"], label: "@file argument" },
		{ args: ["--model", "cast/gpt-5", "fix tests"], label: "message after valued flag" },
	])("detects $label as explicit Default-session intent", ({ args }) => {
		expect(launch(args).explicitDefaultIntent).toBe(true)
	})

	it.each([
		["--print", "fix tests"],
		["--mode", "json", "fix tests"],
		["--mode", "rpc"],
	])("detects automation mode for %s", (...args) => {
		expect(launch(args).nonInteractiveMode).toBe(true)
	})

	it("uses Kimchi's non-interactive pre-dispatch classification", () => {
		expect(launch(["--mode", "acp"], { nonInteractiveMode: true }).nonInteractiveMode).toBe(true)
	})

	it.each([["--continue"], ["-c"], ["--resume"], ["--session", "abc123"], ["--fork", "abc123"]])(
		"detects explicit session launch for %s",
		(...args) => {
			expect(launch(args).explicitSession).toBe(true)
		},
	)

	it("does not treat unknown extension flag values as initial messages", () => {
		expect(launch(["--custom-flag", "value"]).explicitDefaultIntent).toBe(false)
	})
})

describe("decideSessionModeOnboarding", () => {
	it("shows on first plain interactive startup", () => {
		expect(decide([])).toEqual({ action: "show", reason: "eligible" })
	})

	it("skips when the session mode dialog is hidden", () => {
		expect(decide([], { hideSessionModeDialog: true })).toEqual({
			action: "skip",
			reason: "hidden",
		})
	})

	it("skips returning launches once the dialog has been seen", () => {
		expect(decide([], { seenAt: "2026-05-19T08:00:00.000Z" })).toEqual({ action: "skip", reason: "already-seen" })
	})

	it("marks an explicit prompt launch as Default-session intent", () => {
		expect(decide(["fix tests"])).toEqual({ action: "skip-and-mark-seen", reason: "explicit-default-session" })
	})

	it.each([
		{ args: ["--print", "fix tests"], expected: { action: "skip", reason: "automation-mode" } },
		{ args: ["--mode", "json"], expected: { action: "skip", reason: "automation-mode" } },
		{ args: ["--continue"], expected: { action: "skip", reason: "explicit-session" } },
	])("skips for $args", ({ args, expected }) => {
		expect(decide(args)).toEqual(expected as SessionModeOnboardingDecision)
	})

	it("skips without marking when UI is unavailable", () => {
		expect(decide(["fix tests"], { hasUI: false })).toEqual({ action: "skip", reason: "not-interactive-tty" })
	})

	it("skips without marking in piped stdin mode", () => {
		expect(decide(["fix tests"], { launchContext: launch(["fix tests"], { stdinIsTTY: false }) })).toEqual({
			action: "skip",
			reason: "not-interactive-tty",
		})
	})

	it("skips non-startup session_start events", () => {
		expect(decide([], { sessionStartReason: "resume" })).toEqual({ action: "skip", reason: "explicit-session" })
	})
})

describe("session-mode onboarding persistence", () => {
	let tempDir: string
	let configPath: string
	const now = () => new Date("2026-05-19T09:30:00.000Z")

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-session-mode-onboarding-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it.each(["default", "ferment"] as const)("marks %s choices as seen", (outcome) => {
		const seenAt = recordSessionModeWizardOutcome(outcome, { configPath, now })
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))

		expect(seenAt).toBe("2026-05-19T09:30:00.000Z")
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
	})

	it("does not mark cancellation as seen", () => {
		const seenAt = recordSessionModeWizardOutcome("cancelled", { configPath, now })

		expect(seenAt).toBeUndefined()
		expect(existsSync(configPath)).toBe(false)
	})

	it("extension marks explicit Default-session launches on startup", async () => {
		const harness = createExtensionHarness()
		sessionModeOnboardingExtension({ launchContext: launch(["fix tests"]), configPath, now })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()

		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
	})

	it("does not mount or mark seen while a startup prerequisite suppresses onboarding", async () => {
		const harness = createExtensionHarness()
		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now, shouldSkip: () => true })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()

		expect(harness.ui.setWidget).not.toHaveBeenCalled()
		expect(existsSync(configPath)).toBe(false)
	})

	it("extension mounts the picker and records Default selection", async () => {
		const harness = createExtensionHarness()

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()
		expect(harness.ui.setWidget).toHaveBeenCalled()
		expect(harness.ui.onTerminalInput).toHaveBeenCalled()
		let raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")

		harness.input("\x1b[B")
		expect(harness.tui.requestRender).toHaveBeenCalled()
		harness.input("\r")
		await harness.settle()

		raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
		expect(harness.activeComponent()).toBeUndefined()
	})

	it("swaps the editor immediately when no overlay is active at mount", async () => {
		const upstreamFactory = vi.fn()
		const harness = createExtensionHarness({ initialEditorFactory: upstreamFactory })

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()

		expect(harness.ui.getEditorComponent).toHaveBeenCalledTimes(1)
		expect(harness.ui.setEditorComponent).toHaveBeenCalledTimes(1)
		expect(harness.ui.setEditorComponent).not.toHaveBeenCalledWith(upstreamFactory)
	})

	it("defers the editor swap while an overlay is up so the overlay keeps input focus", async () => {
		// Swapping the editor while an overlay is up steals pi-tui's input
		// routing and prevents overlay dismissal — keep the editor visible
		// (even if visually noisy) until the overlay clears.
		const upstreamFactory = vi.fn()
		const harness = createExtensionHarness({ initialEditorFactory: upstreamFactory })
		harness.setOverlay(true)

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()

		expect(harness.ui.setEditorComponent).not.toHaveBeenCalled()
		expect(harness.activeComponent()).toBeDefined()
	})

	it("swaps the editor on the first input after the overlay clears, then restores on cleanup", async () => {
		const upstreamFactory = vi.fn()
		const harness = createExtensionHarness({ initialEditorFactory: upstreamFactory })
		harness.setOverlay(true)

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()
		expect(harness.ui.setEditorComponent).not.toHaveBeenCalled()

		harness.setOverlay(false)
		harness.input("\x1b[B")

		expect(harness.ui.setEditorComponent).toHaveBeenCalledTimes(1)
		const swappedFactory = harness.ui.setEditorComponent.mock.calls[0][0]
		expect(swappedFactory).not.toBe(upstreamFactory)

		harness.shutdown()
		await harness.settle()
		expect(harness.ui.setEditorComponent).toHaveBeenLastCalledWith(upstreamFactory)
	})

	it("hides the editor on the same keystroke that dismisses the overlay (deferred via setTimeout)", async () => {
		vi.useFakeTimers()
		try {
			const upstreamFactory = vi.fn()
			const harness = createExtensionHarness({ initialEditorFactory: upstreamFactory })
			harness.setOverlay(true)

			sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now })(
				harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
			)

			await harness.start()
			expect(harness.ui.setEditorComponent).not.toHaveBeenCalled()

			// Simulate the dismiss keystroke: our handler fires while overlay is
			// still up (schedules setTimeout retry), then overlay flips off as a
			// synchronous side effect of the same key.
			harness.input("x")
			harness.setOverlay(false)
			expect(harness.ui.setEditorComponent).not.toHaveBeenCalled()

			vi.runAllTimers()
			expect(harness.ui.setEditorComponent).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it("extension cancellation clears the picker after recording that the first dialog was shown", async () => {
		const harness = createExtensionHarness()

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()
		harness.input("\x1b")
		await harness.settle()

		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
		expect(harness.activeComponent()).toBeUndefined()
	})

	it("preserves picker selection when pi-tui re-invokes the widget factory", async () => {
		const harness = createExtensionHarness()

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()
		harness.input("\x1b[B")
		const before = harness.activeComponent() as { getState(): { selectedIndex: number } } | undefined
		expect(before?.getState().selectedIndex).toBe(1)

		// Simulate a resize / theme swap that re-invokes the most recent
		// widget factory. The new component must start from the existing
		// selection, not reset to 0.
		const calls = harness.ui.setWidget.mock.calls
		const lastFactory = calls[calls.length - 1][1] as (...args: unknown[]) => unknown
		harness.ui.setWidget("kimchi-session-mode-onboarding", lastFactory, calls[calls.length - 1][2])
		const after = harness.activeComponent() as { getState(): { selectedIndex: number } } | undefined
		expect(after).not.toBe(before)
		expect(after?.getState().selectedIndex).toBe(1)
	})

	it("shutdown cleans up the picker", async () => {
		const harness = createExtensionHarness()

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()
		expect(harness.activeComponent()).toBeDefined()
		harness.shutdown()
		await harness.settle()

		expect(harness.activeComponent()).toBeUndefined()
	})

	it("extension exposes Ferment selection through the outcome callback", async () => {
		const harness = createExtensionHarness()
		const onOutcome = vi.fn()

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now, onOutcome })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()
		harness.input("\r")
		await harness.settle()

		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
		expect(onOutcome).toHaveBeenCalledWith("ferment", expect.objectContaining({ ui: harness.ui }), harness.api)
	})

	it("reports synchronous errors from the outcome callback", async () => {
		const harness = createExtensionHarness()
		const onOutcome = vi.fn(() => {
			throw new Error("sync boom")
		})

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now, onOutcome })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()
		harness.input("\r")
		await harness.settle()

		expect(onOutcome).toHaveBeenCalledWith("ferment", expect.objectContaining({ ui: harness.ui }), harness.api)
		expect(harness.ui.notify).toHaveBeenCalledWith("Session mode startup failed: sync boom", "warning")
	})

	it("extension exposes 'just chat and code' selection through the outcome callback", async () => {
		const harness = createExtensionHarness()
		const onOutcome = vi.fn()

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now, onOutcome })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()
		harness.input("\x1b[B")
		harness.input("\r")
		await harness.settle()

		expect(harness.activeComponent()).toBeUndefined()
		expect(onOutcome).toHaveBeenCalledWith("default", expect.objectContaining({ ui: harness.ui }), harness.api)
	})
})
