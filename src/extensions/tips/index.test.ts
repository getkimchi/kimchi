import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import tipsExtension, { TIPS_WIDGET_KEY } from "./index.js"
import { TipRegistry } from "./registry.js"

type Handler = (event: unknown, ctx: unknown) => unknown

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
	const tui = { requestRender: vi.fn() } as unknown as TUI
	const ui = {
		setWidget: vi.fn((_key: string, content: unknown) => {
			if (typeof content === "function") {
				component = content(tui, theme()) as { render(width: number): string[] }
			}
		}),
	}
	const ctx = { hasUI: options.hasUI, ui }
	const api = {
		on: vi.fn((event: string, handler: Handler) => {
			handlers.set(event, handler)
		}),
	} as unknown as ExtensionAPI

	const registry = new TipRegistry()
	tipsExtension({ registry })(api)

	return {
		component: () => component,
		ctx,
		registry,
		start: () => handlers.get("session_start")?.({ reason: "startup" }, ctx),
		shutdown: () => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx),
		turnEnd: () => handlers.get("turn_end")?.({ message: { role: "assistant" } }, ctx),
		tui,
		ui,
	}
}

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

		harness.turnEnd()

		expect(harness.ui.setWidget).not.toHaveBeenCalledWith(TIPS_WIDGET_KEY, undefined, {
			placement: "aboveEditor",
		})
		expect(harness.tui.requestRender).toHaveBeenCalledTimes(1)
	})

	it("does not render tips when UI is unavailable", () => {
		const harness = createHarness({ hasUI: false })

		harness.start()

		expect(harness.ui.setWidget).not.toHaveBeenCalled()
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
})
