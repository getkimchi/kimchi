import { type Component, Container, ScrollView, stripTerminalSequences } from "@earendil-works/pi-tui"
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
	const pill = new SelectionPill({ host: () => host, theme: testTheme, excludeWithin: () => undefined, onAdd })
	const select = (startRow: number, endRow: number, endCol: number) =>
		setSelection({
			text: "selected text",
			bounds: { start: { row: startRow, col: 0, scrollView }, end: { row: endRow, col: endCol, scrollView } },
		})
	const screen = Array.from({ length: rect.height }, () => " ".repeat(rect.width))
	return { host, pill, frame, screen, select, onAdd, scrollView }
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

	it("hides when the selection scrolled out above the viewport", () => {
		const { pill, frame, screen, select, scrollView } = setup()
		select(1, 2, 40)
		Object.defineProperty(scrollView, "scrollTop", { get: () => 10 })

		expect(pill.paint(screen, frame, 60)).toBe(screen)
	})

	it("hides when the selection scrolled out below the viewport instead of clamping into view", () => {
		const { pill, frame, screen, select } = setup()
		// Viewport is 10 rows: both candidate anchor rows (below end, above start) fall outside.
		select(15, 17, 40)

		expect(pill.paint(screen, frame, 60)).toBe(screen)
	})

	it("keeps painting from the selection bounds when its text extraction is temporarily unavailable", () => {
		// Mid-stream the previous-layout text extraction can come back empty for
		// a frame; the pill must follow the bounds regardless, otherwise it blips.
		const { host, pill, frame, screen, scrollView } = setup()
		const bounds = {
			start: { row: 1, col: 0, scrollView },
			end: { row: 2, col: 40, scrollView },
		}
		vi.mocked(host.settledSelection).mockReturnValue(undefined)
		vi.mocked(host.selectionBounds).mockReturnValue(bounds)

		expect(plain(pill.paint(screen, frame, 60))[3]).toContain(LABEL)
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

	it("eats a click mid-stream without quoting or clearing the selection, and quotes on retry", () => {
		const { host, pill, frame, screen, select, scrollView, onAdd } = setup()
		select(1, 2, 40)
		pill.paint(screen, frame, 60)

		// The mid-stream frame this file's bounds-only paint covers: the pill is
		// visible but text extraction momentarily fails.
		const bounds = { start: { row: 1, col: 0, scrollView }, end: { row: 2, col: 40, scrollView } }
		vi.mocked(host.settledSelection).mockReturnValue(undefined)
		expect(pill.handleMouse(press(30, 3))).toBe(true)
		expect(onAdd).not.toHaveBeenCalled()
		expect(host.clearSelection).not.toHaveBeenCalled()
		// The release is not swallowed (no add happened).
		expect(pill.handleMouse(press(30, 3, true))).toBe(false)

		// Extraction recovers next frame: the same click quotes.
		vi.mocked(host.settledSelection).mockReturnValue({ bounds, text: "selected text" })
		expect(pill.handleMouse(press(30, 3))).toBe(true)
		expect(onAdd).toHaveBeenCalledWith("selected text")
	})

	it("lets a second click on the consumed pill's spot start a new selection before the next paint", () => {
		const { pill, frame, screen, select } = setup()
		select(1, 2, 40)
		pill.paint(screen, frame, 60)

		expect(pill.handleMouse(press(30, 3))).toBe(true)
		expect(pill.handleMouse(press(30, 3, true))).toBe(true)

		// The rect was disarmed on consume: no press under the dead pixels is eaten.
		expect(pill.handleMouse(press(30, 3))).toBe(false)
	})

	describe("with an excluded pane (the open side chat)", () => {
		function splitSetup() {
			const { host, setFrame, setSelection } = createSideChatHost()
			const mainView = new ScrollView(new Container())
			const sideView = new ScrollView(new Container())
			const panelRoot: Component = { render: () => [], invalidate: () => {} }
			const frame = frameOf(120, 10, [
				frameBox(mainView, { x: 0, y: 0, width: 80, height: 10 }),
				frameBox(panelRoot, { x: 80, y: 0, width: 40, height: 10 }, [
					frameBox(sideView, { x: 80, y: 0, width: 40, height: 10 }),
				]),
			])
			setFrame(frame)
			const onAdd = vi.fn()
			const pill = new SelectionPill({
				host: () => host,
				theme: testTheme,
				excludeWithin: () => panelRoot,
				onAdd,
			})
			const select = (scrollView: ScrollView) =>
				setSelection({
					text: "selected text",
					bounds: { start: { row: 1, col: 0, scrollView }, end: { row: 2, col: 20, scrollView } },
				})
			const screen = Array.from({ length: 10 }, () => " ".repeat(120))
			return { host, pill, frame, screen, select, onAdd, mainView, sideView }
		}

		it("paints nothing when the selection is inside the side chat pane", () => {
			const { pill, frame, screen, select, sideView } = splitSetup()
			select(sideView)

			const result = pill.paint(screen, frame, 120)

			expect(result).toBe(screen)
			expect(plain(result).every((row) => !row.includes(LABEL))).toBe(true)
		})

		it("still paints when the selection is in the main transcript", () => {
			const { pill, frame, screen, select, mainView } = splitSetup()
			select(mainView)

			const rows = plain(pill.paint(screen, frame, 120))

			expect(rows[3]).toContain(LABEL)
		})
	})
})
