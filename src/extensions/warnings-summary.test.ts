import type { TUI } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext, mountWidget } from "./__mocks__/context.js"
import {
	recordRelayedWarning,
	resetWarningsSummaryForTests,
	trackWarningsSummaryContext,
	WARNINGS_WIDGET_KEY,
} from "./warnings-summary.js"

beforeEach(() => {
	resetWarningsSummaryForTests()
})

afterEach(() => {
	resetWarningsSummaryForTests()
})

describe("recordRelayedWarning", () => {
	it("mounts the widget once on the first warning and re-renders it for later ones", () => {
		const ctx = createContext()
		const tui = { requestRender: vi.fn() }
		trackWarningsSummaryContext(ctx)
		expect(ctx.ui.setWidget).toHaveBeenCalledWith(WARNINGS_WIDGET_KEY, undefined)

		recordRelayedWarning("first warning")
		const component = mountWidget(ctx, WARNINGS_WIDGET_KEY, tui as Partial<TUI>)
		recordRelayedWarning("second warning")

		expect(ctx.ui.setWidget).toHaveBeenCalledTimes(2)
		expect(tui.requestRender).toHaveBeenCalledTimes(1)
		expect(component?.render(120)[0]).toContain("[2 warnings] Latest: second warning")
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("track clears the widget and starts the next session empty", () => {
		const first = createContext()
		trackWarningsSummaryContext(first)
		recordRelayedWarning("old session warning")
		mountWidget(first, WARNINGS_WIDGET_KEY)

		const second = createContext()
		trackWarningsSummaryContext(second)
		expect(second.ui.setWidget).toHaveBeenLastCalledWith(WARNINGS_WIDGET_KEY, undefined)

		recordRelayedWarning("fresh session warning")
		const lines = mountWidget(second, WARNINGS_WIDGET_KEY)?.render(120) ?? []
		expect(lines[0]).toContain("[1 warning] Latest: fresh session warning")
	})
})

describe("recordRelayedWarning fallbacks", () => {
	it("falls back to ctx.ui.notify when the tracked context has no UI", () => {
		const headless = createContext({ hasUI: false })
		trackWarningsSummaryContext(headless)

		recordRelayedWarning("headless-ish warning")

		expect(headless.ui.notify).toHaveBeenCalledWith("headless-ish warning", "warning")
		expect(headless.ui.setWidget).not.toHaveBeenCalled()
	})
})

describe("warnings widget", () => {
	it("renders collapsed by default: count + latest (newlines flattened) + expand hint", () => {
		const ctx = createContext()
		trackWarningsSummaryContext(ctx)
		recordRelayedWarning("MCP: 105 direct tools resolved.")
		recordRelayedWarning("second issue\nwith detail")

		const lines = mountWidget(ctx, WARNINGS_WIDGET_KEY)?.render(120) ?? []

		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain("[2 warnings] Latest: second issue with detail")
		expect(lines[0]).toContain("(ctrl+o to expand)")
		expect(lines.join("\n")).not.toContain("MCP: 105 direct tools resolved.")
	})

	it("expands with ctrl+o to the full live entry list", () => {
		const ctx = createContext()
		trackWarningsSummaryContext(ctx)
		recordRelayedWarning("first message")
		const component = mountWidget(ctx, WARNINGS_WIDGET_KEY)
		vi.mocked(ctx.ui.getToolsExpanded).mockReturnValue(true)

		recordRelayedWarning("late arrival")

		expect(component?.render(120)).toEqual([expect.stringContaining("[Warnings]"), "first message", "late arrival"])
	})

	it("caps the list at 50 entries, summarizes overflow, and counts the uncapped total", () => {
		const ctx = createContext()
		trackWarningsSummaryContext(ctx)
		for (let i = 0; i < 55; i++) recordRelayedWarning(`warn ${i}`)
		const component = mountWidget(ctx, WARNINGS_WIDGET_KEY)

		expect(component?.render(120)[0]).toContain("[55 warnings] Latest: warn 54")

		vi.mocked(ctx.ui.getToolsExpanded).mockReturnValue(true)
		const lines = component?.render(120) ?? []
		expect(lines).toHaveLength(1 + 1 + 50)
		expect(lines[1]).toBe("… (5 earlier warnings not shown)")
		expect(lines[2]).toBe("warn 5")
	})
})
