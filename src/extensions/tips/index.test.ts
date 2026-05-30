import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { visibleWidth } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import tipsExtension, { TIPS_WIDGET_KEY, setTipWidgetLocation } from "./index.js"
import { TipRegistry } from "./registry.js"

const mockHideTips = vi.fn().mockReturnValue(false)
const mockWriteHideTips = vi.fn()

vi.mock("../../config.js", () => ({
	readHideTips: (...args: unknown[]) => mockHideTips(...args),
	writeHideTips: (...args: unknown[]) => mockWriteHideTips(...args),
}))

type Handler = (event: unknown, ctx: unknown) => unknown
const harnesses: Array<{ shutdown: () => unknown }> = []
const restoreLocations: Array<() => void> = []

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

function createHarness(options: { hasUI: boolean }) {
	const handlers = new Map<string, Handler>()
	let component: { render(width: number): string[] } | undefined
	const requestRender = vi.fn()
	const tui = { requestRender } as unknown as TUI
	const notifications: Array<{ message: string; level: string }> = []
	const ui = {
		setWidget: vi.fn((_key: string, content: unknown) => {
			if (typeof content === "function") {
				component = content(tui, theme()) as { render(width: number): string[] }
			}
		}),
		notify: vi.fn((message: string, level: string) => {
			notifications.push({ message, level })
		}),
		custom: vi.fn(),
	}
	const ctx = { hasUI: options.hasUI, ui, cwd: "/test" }
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<unknown> }>()
	const api = {
		on: vi.fn((event: string, handler: Handler) => {
			handlers.set(event, handler)
		}),
		registerCommand: vi.fn((name: string, command: unknown) => {
			commands.set(name, command as { description: string; handler: (args: string, ctx: unknown) => Promise<unknown> })
		}),
	} as unknown as ExtensionAPI

	const registry = new TipRegistry()
	tipsExtension({ registry })(api)

	const harness = {
		component: () => component,
		commands,
		ctx,
		getNotifications: () => notifications,
		registry,
		start: () => handlers.get("session_start")?.({ reason: "startup" }, ctx),
		shutdown: () => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx),
		turnEnd: () => handlers.get("turn_end")?.({ message: { role: "assistant" } }, ctx),
		requestRender,
		tui,
		ui,
	}
	harnesses.push(harness)
	return harness
}

beforeEach(() => {
	mockHideTips.mockReturnValue(false)
	mockWriteHideTips.mockClear()
})

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.shutdown()
	for (const restore of restoreLocations.splice(0).reverse()) restore()
})

describe("tips extension", () => {
	it("mounts a general tip widget in interactive sessions", () => {
		const harness = createHarness({ hasUI: true })

		harness.start()

		expect(harness.ui.setWidget).toHaveBeenCalledWith(TIPS_WIDGET_KEY, expect.any(Function), {
			placement: "aboveEditor",
		})
		const lines = harness.component()?.render(32)
		expect(lines).toHaveLength(1)
		expect(visibleWidth(lines?.[0] ?? "")).toBeLessThanOrEqual(32)
	})

	it("keeps the mounted widget visible and rerenders after turns while tips remain eligible", () => {
		const harness = createHarness({ hasUI: true })
		harness.start()
		harness.ui.setWidget.mockClear()
		harness.requestRender.mockClear()

		harness.turnEnd()

		expect(harness.ui.setWidget).not.toHaveBeenCalledWith(TIPS_WIDGET_KEY, undefined, {
			placement: "aboveEditor",
		})
		expect(harness.requestRender).toHaveBeenCalledTimes(1)
	})

	it("does not render tips when UI is unavailable", () => {
		const harness = createHarness({ hasUI: false })

		harness.start()

		expect(harness.ui.setWidget).not.toHaveBeenCalled()
	})

	it("hides and restores the mounted tip widget while hidden", () => {
		const harness = createHarness({ hasUI: true })
		harness.start()
		harness.ui.setWidget.mockClear()

		const restoreLocation = setTipWidgetLocation("hidden")
		restoreLocations.push(restoreLocation)

		expect(harness.ui.setWidget).toHaveBeenCalledWith(TIPS_WIDGET_KEY, undefined, {
			placement: "aboveEditor",
		})
		harness.ui.setWidget.mockClear()

		restoreLocation()

		expect(harness.ui.setWidget).toHaveBeenCalledWith(TIPS_WIDGET_KEY, expect.any(Function), {
			placement: "aboveEditor",
		})
	})

	it("clears the widget and unregisters its general provider on shutdown", () => {
		const harness = createHarness({ hasUI: true })
		harness.start()

		harness.shutdown()

		expect(harness.ui.setWidget).toHaveBeenLastCalledWith(TIPS_WIDGET_KEY, undefined, {
			placement: "aboveEditor",
		})
		expect(harness.registry.getFirstTip("general")).toBeUndefined()
	})

	it("does not mount widget when hideTips is true", () => {
		mockHideTips.mockReturnValue(true)
		const harness = createHarness({ hasUI: true })

		harness.start()

		expect(harness.ui.setWidget).not.toHaveBeenCalledWith(TIPS_WIDGET_KEY, expect.any(Function), {
			placement: "aboveEditor",
		})
	})

	it("handles /tips disable command", async () => {
		const harness = createHarness({ hasUI: true })
		harness.start()

		const tipsCmd = harness.commands.get("tips")
		expect(tipsCmd).toBeDefined()
		await tipsCmd?.handler("disable", harness.ctx)

		expect(mockWriteHideTips).toHaveBeenCalledWith(true)
	})

	it("handles /tips enable command", async () => {
		mockHideTips.mockReturnValue(true)
		const harness = createHarness({ hasUI: true })
		harness.start()
		harness.ui.setWidget.mockClear()

		const tipsCmd = harness.commands.get("tips")
		expect(tipsCmd).toBeDefined()
		await tipsCmd?.handler("enable", harness.ctx)

		expect(mockWriteHideTips).toHaveBeenCalledWith(false)
		expect(harness.ui.setWidget).toHaveBeenCalledWith(TIPS_WIDGET_KEY, expect.any(Function), {
			placement: "aboveEditor",
		})
	})
})
