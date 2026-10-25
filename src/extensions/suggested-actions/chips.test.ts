import { stripVTControlCharacters as plain } from "node:util"
import { type Component, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { testTheme } from "../__mocks__/theme.js"
import { createSuggestionChips } from "./chips.js"
import type { Suggestion } from "./detect.js"

const PR = "https://github.com/acme/app/pull/1531"

function suggestion(watching = false): Suggestion {
	return { key: PR, label: "PR #1531", skill: "watch-pr", args: PR, watching }
}

function click(component: Component, x: number): void {
	for (const type of ["press", "click"] as const) {
		const event: TuiMouseEvent = {
			type,
			button: "left",
			x,
			y: 0,
			screenX: x,
			screenY: 0,
			width: 80,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
		}
		component.handleMouse?.(event)
	}
}

function setup(suggestions: Suggestion[]) {
	const onRun = vi.fn()
	const onDismiss = vi.fn()
	const chips = createSuggestionChips(testTheme, { suggestions: () => suggestions, onRun, onDismiss })
	return { chips, onRun, onDismiss }
}

describe("createSuggestionChips", () => {
	it("runs the suggestion on a chip click and dismisses it on ×", () => {
		const { chips, onRun, onDismiss } = setup([suggestion()])
		const line = plain(chips.render(80)[0])
		expect(line).toBe("  ◉ Watch PR #1531  ×")

		click(chips, line.indexOf("Watch"))
		expect(onRun).toHaveBeenCalledWith(suggestion())

		click(chips, line.indexOf("×"))
		expect(onDismiss).toHaveBeenCalledWith(suggestion())
	})

	it("shows a running watch as disabled", () => {
		const { chips, onRun } = setup([suggestion(true)])
		const line = plain(chips.render(80)[0])
		expect(line).toBe("  ◌ Watching PR #1531  ×")

		click(chips, line.indexOf("Watching"))
		expect(onRun).not.toHaveBeenCalled()
	})

	it("renders nothing without suggestions", () => {
		expect(setup([]).chips.render(80)).toEqual([])
	})

	it.each([0, 1, 10])("leaves out chips that do not fit in %i columns", (width) => {
		const [line] = setup([suggestion()]).chips.render(width)
		expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width))
	})
})
