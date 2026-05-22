import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import { globalTipRegistry } from "../tips/registry.js"
import { createSessionModeOnboardingForStartup } from "./session-mode-startup.js"

type SessionStartHandler = (event: unknown, ctx: unknown) => unknown
const startupHarnesses: Array<{ shutdown: () => unknown }> = []

function createHarness(options: {
	rawArgs?: string[]
	nonInteractiveMode?: boolean
	stdinIsTTY?: boolean
	stdoutIsTTY?: boolean
}) {
	const handlers = new Map<string, SessionStartHandler>()
	const api = {
		on: vi.fn((event: string, handler: SessionStartHandler) => {
			handlers.set(event, handler)
		}),
	} as unknown as ExtensionAPI
	const tui = { requestRender: vi.fn() } as unknown as TUI
	const ui = {
		setWidget: vi.fn(),
		notify: vi.fn(),
	}
	const ctx = { hasUI: true, ui }
	const extension = createSessionModeOnboardingForStartup({
		rawArgs: options.rawArgs ?? [],
		nonInteractiveMode: options.nonInteractiveMode ?? false,
		stdinIsTTY: options.stdinIsTTY ?? true,
		stdoutIsTTY: options.stdoutIsTTY ?? true,
	})

	extension(api)

	const harness = {
		api,
		ctx,
		ui,
		tui,
		start: () => handlers.get("session_start")?.({ reason: "startup" }, ctx),
		shutdown: () => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx),
	}
	startupHarnesses.push(harness)
	return harness
}

describe("session mode startup integration", () => {
	afterEach(() => {
		for (const harness of startupHarnesses.splice(0)) {
			harness.shutdown()
		}
		globalTipRegistry.clear()
	})

	it("does not mount any widget on the first eligible interactive startup", async () => {
		const harness = createHarness({})

		await harness.start()

		expect(harness.ui.setWidget).not.toHaveBeenCalled()
	})

	it("skips launches when the session mode dialog has been hidden", async () => {
		const harness = createHarness({})

		await harness.start()

		expect(harness.ui.setWidget).not.toHaveBeenCalled()
	})

	it("treats an explicit prompt launch as Default without mounting the picker", async () => {
		const harness = createHarness({ rawArgs: ["fix tests"] })

		await harness.start()

		expect(harness.ui.setWidget).not.toHaveBeenCalled()
	})

	it("stays silent for automation and non-interactive launches", async () => {
		const automation = createHarness({ rawArgs: ["--mode", "json"] })
		await automation.start()
		expect(automation.ui.setWidget).not.toHaveBeenCalled()

		const acp = createHarness({ rawArgs: ["--mode", "acp"], nonInteractiveMode: true })
		await acp.start()
		expect(acp.ui.setWidget).not.toHaveBeenCalled()

		const piped = createHarness({ stdinIsTTY: false })
		await piped.start()
		expect(piped.ui.setWidget).not.toHaveBeenCalled()
	})
})
