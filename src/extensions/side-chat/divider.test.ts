import type { Component } from "@earendil-works/pi-tui"
import { stripTerminalSequences } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSideChatHost, frameBox, frameOf } from "../__mocks__/side-chat-host.js"
import { testTheme } from "../__mocks__/theme.js"
import { PaneDivider } from "./divider.js"
import { MAIN_PANEL_MIN_WIDTH, type RawMouseEvent, SIDE_PANEL_MIN_WIDTH } from "./harness.js"

const WIDTH = 100
const DIVIDER_X = 60

function setup() {
	const { host, setFrame } = createSideChatHost()
	const panelRoot: Component = { render: () => [], invalidate: () => {} }
	const onResize = vi.fn()
	const divider = new PaneDivider({ host, theme: testTheme, panelRoot, onResize })
	const frame = frameOf(WIDTH, 10, [
		frameBox(divider.component, { x: DIVIDER_X, y: 0, width: 1, height: 1 }),
		frameBox(panelRoot, { x: DIVIDER_X + 1, y: 0, width: WIDTH - DIVIDER_X - 1, height: 10 }),
	])
	setFrame(frame)
	return { divider, frame, onResize }
}

const mouse = (x: number, y: number, options: { release?: boolean; motion?: boolean } = {}): RawMouseEvent => ({
	button: options.motion ? 32 : 0,
	x,
	y,
	release: options.release ?? false,
})

afterEach(() => {
	vi.useRealTimers()
})

describe("PaneDivider", () => {
	it("paints the divider over the panel's full height with a centred grip", () => {
		const { divider, frame } = setup()

		const rows = divider
			.paint(Array(10).fill(" ".repeat(WIDTH)), frame, WIDTH)
			.map((row) => stripTerminalSequences(row))

		expect(rows.map((row) => row[DIVIDER_X])).toEqual(["│", "│", "│", "┃", "┃", "┃", "│", "│", "│", "│"])
	})

	it("resizes the side panel while dragging, clamped to both minimum widths", () => {
		const { divider, onResize } = setup()

		expect(divider.handleMouse(mouse(DIVIDER_X, 5))).toBe(true)
		divider.handleMouse(mouse(50, 5, { motion: true }))
		divider.handleMouse(mouse(0, 5, { motion: true }))
		divider.handleMouse(mouse(WIDTH - 1, 5, { motion: true }))
		expect(divider.handleMouse(mouse(WIDTH - 1, 5, { release: true }))).toBe(true)

		expect(onResize.mock.calls).toEqual([[WIDTH - 50 - 1], [WIDTH - 1 - MAIN_PANEL_MIN_WIDTH], [SIDE_PANEL_MIN_WIDTH]])
	})

	it("resets the default split on double-click", () => {
		vi.useFakeTimers()
		const { divider, onResize } = setup()

		divider.handleMouse(mouse(DIVIDER_X, 5))
		divider.handleMouse(mouse(DIVIDER_X, 5, { release: true }))
		vi.advanceTimersByTime(100)
		divider.handleMouse(mouse(DIVIDER_X, 5))

		expect(onResize).toHaveBeenCalledWith(undefined)
	})

	it("ignores presses off the divider column", () => {
		const { divider, onResize } = setup()

		expect(divider.handleMouse(mouse(DIVIDER_X - 1, 5))).toBe(false)
		expect(divider.handleMouse(mouse(DIVIDER_X, 5, { release: true }))).toBe(false)
		expect(onResize).not.toHaveBeenCalled()
	})
})
