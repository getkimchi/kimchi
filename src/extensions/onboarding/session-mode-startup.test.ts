import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeSessionModeWizardSeenAt } from "../../config.js"
import { globalTipRegistry } from "../tips/registry.js"
import { createSessionModeOnboardingForStartup } from "./session-mode-startup.js"

type SessionStartHandler = (event: unknown, ctx: unknown) => unknown
type TerminalInputHandler = (data: string) => { consume?: boolean } | undefined
type CustomComponent = { handleInput?(data: string): void }
const startupHarnesses: Array<{ shutdown: () => unknown; settle: () => Promise<void> }> = []

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

function createHarness(options: {
	rawArgs?: string[]
	nonInteractiveMode?: boolean
	stdinIsTTY?: boolean
	stdoutIsTTY?: boolean
	configPath: string
	now: () => Date
	startFerment?: ReturnType<typeof vi.fn>
}) {
	const handlers = new Map<string, SessionStartHandler>()
	const api = {
		on: vi.fn((event: string, handler: SessionStartHandler) => {
			handlers.set(event, handler)
		}),
	} as unknown as ExtensionAPI
	const tui = { requestRender: vi.fn() } as unknown as TUI
	let activeComponent: CustomComponent | undefined
	let inputHandler: TerminalInputHandler | undefined
	const unsubscribe = vi.fn()
	let storedEditorFactory: unknown
	const ui = {
		setWidget: vi.fn((_: string, content: unknown) => {
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
				try {
					const content = factory(tui, theme(), {}, done)
					if (content && typeof (content as Promise<CustomComponent>).then === "function") {
						;(content as Promise<CustomComponent>).then((component) => {
							if (!doneCalled) activeComponent = component
						}, reject)
					} else {
						activeComponent = content as CustomComponent
					}
				} catch (err) {
					reject(err)
				}
			})
		}),
		notify: vi.fn(),
	}
	const ctx = { hasUI: true, ui }
	const extension = createSessionModeOnboardingForStartup({
		rawArgs: options.rawArgs ?? [],
		nonInteractiveMode: options.nonInteractiveMode ?? false,
		stdinIsTTY: options.stdinIsTTY ?? true,
		stdoutIsTTY: options.stdoutIsTTY ?? true,
		configPath: options.configPath,
		now: options.now,
		startFerment: options.startFerment,
	})

	extension(api)

	const harness = {
		api,
		ctx,
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
	startupHarnesses.push(harness)
	return harness
}

describe("session mode startup integration", () => {
	let tempDir: string
	let configPath: string
	const now = () => new Date("2026-05-19T09:30:00.000Z")

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-session-mode-startup-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(async () => {
		for (const harness of startupHarnesses.splice(0)) {
			harness.shutdown()
			await harness.settle()
		}
		globalTipRegistry.clear()
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("mounts the picker on the first eligible interactive startup", async () => {
		const harness = createHarness({ configPath, now })

		await harness.start()

		expect(harness.ui.setWidget).toHaveBeenCalled()
		expect(harness.ui.onTerminalInput).toHaveBeenCalled()
	})

	it("skips returning launches once the dialog has been seen", async () => {
		writeSessionModeWizardSeenAt("2026-05-19T08:00:00.000Z", configPath)
		const harness = createHarness({ configPath, now })

		await harness.start()

		expect(harness.ui.setWidget).not.toHaveBeenCalled()
		expect(harness.ui.onTerminalInput).not.toHaveBeenCalled()
	})

	it("skips launches when the session mode dialog has been hidden via manual config edit", async () => {
		// hideSessionModeDialog is an escape-hatch flag: users opt out by
		// editing the config file directly. No code path sets it from the UI.
		writeFileSync(
			configPath,
			JSON.stringify({
				onboarding: {
					sessionModeWizardSeenAt: "2026-05-19T08:00:00.000Z",
					hideSessionModeDialog: true,
				},
			}),
		)
		const harness = createHarness({ configPath, now })

		await harness.start()

		expect(harness.ui.setWidget).not.toHaveBeenCalled()
		expect(harness.ui.onTerminalInput).not.toHaveBeenCalled()
		expect(harness.ui.custom).not.toHaveBeenCalled()
	})

	it("treats an explicit prompt launch as Default without mounting the picker", async () => {
		const harness = createHarness({ rawArgs: ["fix tests"], configPath, now })

		await harness.start()

		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
		expect(harness.ui.setWidget).not.toHaveBeenCalled()
		expect(harness.ui.custom).not.toHaveBeenCalled()
	})

	it("stays silent for automation and non-interactive launches", async () => {
		const automation = createHarness({ rawArgs: ["--mode", "json"], configPath, now })
		await automation.start()
		expect(automation.ui.setWidget).not.toHaveBeenCalled()
		expect(existsSync(configPath)).toBe(false)

		const acp = createHarness({ rawArgs: ["--mode", "acp"], nonInteractiveMode: true, configPath, now })
		await acp.start()
		expect(acp.ui.setWidget).not.toHaveBeenCalled()
		expect(existsSync(configPath)).toBe(false)

		const piped = createHarness({ stdinIsTTY: false, configPath, now })
		await piped.start()
		expect(piped.ui.setWidget).not.toHaveBeenCalled()
		expect(existsSync(configPath)).toBe(false)
	})

	it("choosing Default marks seen without starting Ferment", async () => {
		const startFerment = vi.fn()
		const harness = createHarness({ configPath, now, startFerment })
		await harness.start()

		harness.input("\x1b[B")
		harness.input("\r")
		await harness.settle()

		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
		expect(startFerment).not.toHaveBeenCalled()
		expect(harness.activeComponent()).toBeUndefined()
	})

	it("choosing Ferment starts the shared interactive Ferment entry", async () => {
		const startFerment = vi.fn()
		const harness = createHarness({ configPath, now, startFerment })
		await harness.start()

		harness.input("\r")
		await harness.settle()

		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
		expect(startFerment).toHaveBeenCalledWith({ pi: harness.api, ctx: harness.ctx })
	})
})
