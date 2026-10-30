import { stripTerminalSequences, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { testTheme } from "../__mocks__/theme.js"
import { actionAt, PanelHeader } from "./header.js"

function header(title = "Which cache?") {
	const onAction = vi.fn()
	const component = new PanelHeader({
		theme: testTheme,
		isFocused: () => true,
		title: () => title,
		isHistoryOpen: () => false,
		onAction,
	})
	return { component, onAction }
}

function click(x: number, width: number, type: TuiMouseEvent["type"] = "click"): TuiMouseEvent {
	return {
		type,
		button: "left",
		x,
		y: 0,
		screenX: x,
		screenY: 0,
		width,
		height: 1,
		shift: false,
		alt: false,
		ctrl: false,
	} as TuiMouseEvent
}

describe("PanelHeader", () => {
	it("pins ≡ and ✕ to the right edge and fills the full width", () => {
		const [line] = header().component.render(40)

		expect(visibleWidth(line)).toBe(40)
		expect(stripTerminalSequences(line)).toMatch(/^ ● Side chat · Which cache\? +≡ {2}✕ $/)
	})

	it("truncates a long title before the buttons", () => {
		const [line] = header("x".repeat(100)).component.render(30)

		expect(visibleWidth(line)).toBe(30)
		expect(stripTerminalSequences(line).endsWith(" ≡  ✕ ")).toBe(true)
	})

	it.each([1, 3, 6])("drops the buttons when %i columns cannot fit them", (width) => {
		const [line] = header().component.render(width)

		expect(visibleWidth(line)).toBeLessThanOrEqual(width)
		expect(stripTerminalSequences(line)).not.toContain("✕")
	})

	it("maps each button's three-cell target to its action", () => {
		expect([34, 35, 36].map((x) => actionAt(x, 40))).toEqual(["history", "history", "history"])
		expect([37, 38, 39].map((x) => actionAt(x, 40))).toEqual(["close", "close", "close"])
		expect(actionAt(33, 40)).toBeUndefined()
		expect(actionAt(0, 6)).toBeUndefined()
	})

	it("acts on click and claims the press so it doesn't start a text selection", () => {
		const { component, onAction } = header()

		expect(component.handleMouse(click(38, 40, "press"))).toEqual({ handled: true })
		expect(onAction).not.toHaveBeenCalled()
		expect(component.handleMouse(click(38, 40))).toEqual({ handled: true })
		expect(onAction).toHaveBeenCalledWith("close")
	})

	it("ignores clicks on the title", () => {
		const { component, onAction } = header()

		expect(component.handleMouse(click(5, 40))).toBeUndefined()
		expect(onAction).not.toHaveBeenCalled()
	})
})
