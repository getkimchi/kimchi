import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { globalTipRegistry } from "../tips/registry.js"
import { SESSION_MODE_PICKER_HINT } from "./session-mode-picker.js"
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

function createExtensionHarness(options: { deferCustomFactory?: boolean } = {}) {
	const handlers = new Map<string, SessionStartHandler>()
	const api = {
		on: vi.fn((event: string, handler: SessionStartHandler) => {
			handlers.set(event, handler)
		}),
	}
	const tui = { requestRender: vi.fn() } as unknown as TUI
	let activeComponent: CustomComponent | undefined
	let inputHandler: TerminalInputHandler | undefined
	const unsubscribe = vi.fn()
	const ui = {
		setWidget: vi.fn((_: string, content: unknown) => {
			if (typeof content === "function") content(tui, theme())
		}),
		onTerminalInput: vi.fn((handler: TerminalInputHandler) => {
			inputHandler = handler
			return unsubscribe
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

	it("shows returning launches when the dialog has been seen but not hidden", () => {
		expect(decide([], { seenAt: "2026-05-19T08:00:00.000Z" })).toEqual({ action: "show", reason: "eligible" })
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

	it("persists the hide setting when the checkbox is selected", () => {
		const seenAt = recordSessionModeWizardOutcome("default", { configPath, now, hideDialog: true })
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))

		expect(seenAt).toBe("2026-05-19T09:30:00.000Z")
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
		expect(raw.onboarding.hideSessionModeDialog).toBe(true)
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

	it("extension mounts the picker and records Default selection", async () => {
		const harness = createExtensionHarness()

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()
		expect(harness.ui.custom).toHaveBeenCalled()
		expect(harness.ui.setWidget).not.toHaveBeenCalled()
		expect(harness.ui.onTerminalInput).not.toHaveBeenCalled()
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

	it("extension replaces the editor while the picker is visible", async () => {
		const harness = createExtensionHarness()

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()

		harness.input("hello")
		harness.input("x")

		expect(harness.ui.custom).toHaveBeenCalled()
		expect(harness.ui.setWidget).not.toHaveBeenCalled()
		expect(harness.ui.onTerminalInput).not.toHaveBeenCalled()
		expect(harness.activeComponent()).toBeDefined()
	})

	it("extension renders the workflow hint inside the picker", async () => {
		const harness = createExtensionHarness()

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()

		const text = harness.activeComponent()?.render?.(140).join("\n")
		expect(text).toContain(`Tip: ${SESSION_MODE_PICKER_HINT.replaceAll("`", "")}`)
		expect(text).not.toContain("`")
		expect(globalTipRegistry.getProviders().some((candidate) => candidate.source === "kimchi.session-mode")).toBe(false)

		harness.input("\x1b")
		await harness.settle()
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

	it("does not mount the picker after cancellation when the host delays the custom factory", async () => {
		const harness = createExtensionHarness({ deferCustomFactory: true })

		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		harness.start()
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

	it("extension lets users choose Coding session and hide future dialogs", async () => {
		const harness = createExtensionHarness()
		const onOutcome = vi.fn()

		recordSessionModeWizardOutcome("default", { configPath, now })
		sessionModeOnboardingExtension({ launchContext: launch([]), configPath, now, onOutcome })(
			harness.api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await harness.start()
		harness.input("\x1b[B")
		harness.input("\x1b[B")
		harness.input("\r")
		await harness.settle()

		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.onboarding.hideSessionModeDialog).toBe(true)
		expect(harness.activeComponent()).toBeUndefined()
		expect(onOutcome).toHaveBeenCalledWith("default", expect.objectContaining({ ui: harness.ui }), harness.api)
	})
})
