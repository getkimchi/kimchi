import { Container, ScrollView, stripTerminalSequences } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { createSideChatHost, frameBox, frameOf } from "../__mocks__/side-chat-host.js"
import { testTheme } from "../__mocks__/theme.js"
import type { RawMouseEvent } from "./harness.js"
import { SelectionPill } from "./selection-pill.js"

const LABEL = " + Add to side chat "

function setup(rect = { x: 0, y: 0, width: 60, height: 10 }) {
	const { host, setFrame, setSelection } = createSideChatHost()
	const scrollView = new ScrollView(new Container())
	const frame = frameOf(rect.width, rect.height, [frameBox(scrollView, rect)])
	setFrame(frame)
	const onAdd = vi.fn()
	const pill = new SelectionPill({ host: () => host, theme: testTheme, onAdd })
	const select = (startRow: number, endRow: number, endCol: number) =>
		setSelection({
			text: "selected text",
			bounds: { start: { row: startRow, col: 0, scrollView }, end: { row: endRow, col: endCol, scrollView } },
		})
	const screen = Array.from({ length: rect.height }, () => " ".repeat(rect.width))
	return { host, pill, frame, screen, select, onAdd }
}

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line))
const press = (x: number, y: number, release = false): RawMouseEvent => ({ button: 0, x, y, release })

describe("SelectionPill", () => {
	it("paints nothing without a settled selection", () => {
		const { pill, frame, screen } = setup()

		expect(pill.paint(screen, frame, 60)).toBe(screen)
	})

	it("paints under the selection end, right-aligned to the end column", () => {
		const { pill, frame, screen, select } = setup()
		select(1, 2, 40)

		const rows = plain(pill.paint(screen, frame, 60))

		expect(rows[3]).toContain(LABEL)
		expect(rows[3].indexOf(LABEL)).toBe(40 - LABEL.length + 1)
	})

	it("moves above the selection start when there is no room below", () => {
		const { pill, frame, screen, select } = setup()
		select(5, 9, 40)

		expect(plain(pill.paint(screen, frame, 60))[4]).toContain(LABEL)
	})

	it("hides when the view is narrower than the pill", () => {
		const { pill, frame, screen, select } = setup({ x: 0, y: 0, width: 10, height: 4 })
		select(0, 0, 5)

		expect(pill.paint(screen, frame, 10)).toBe(screen)
	})

	it("adds the selection on click and swallows the release", () => {
		const { host, pill, frame, screen, select, onAdd } = setup()
		select(1, 2, 40)
		pill.paint(screen, frame, 60)

		expect(pill.handleMouse(press(30, 3))).toBe(true)
		expect(onAdd).toHaveBeenCalledWith("selected text")
		expect(host.clearSelection).toHaveBeenCalled()
		expect(pill.handleMouse(press(30, 3, true))).toBe(true)
		expect(pill.handleMouse(press(30, 3, true))).toBe(false)
	})

	it("ignores clicks outside the pill", () => {
		const { pill, frame, screen, select, onAdd } = setup()
		select(1, 2, 40)
		pill.paint(screen, frame, 60)

		expect(pill.handleMouse(press(30, 4))).toBe(false)
		expect(pill.handleMouse(press(41, 3))).toBe(false)
		expect(onAdd).not.toHaveBeenCalled()
	})
})
