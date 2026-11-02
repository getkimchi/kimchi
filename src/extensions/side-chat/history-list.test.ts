import { stripTerminalSequences } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { testTheme } from "../__mocks__/theme.js"
import { HistoryList } from "./history-list.js"

const ENTER = "\r"
const ESCAPE = "\x1b"
const DOWN = "\x1b[B"

function setup(onShortcut = vi.fn(() => false)) {
	const onPick = vi.fn()
	const onCancel = vi.fn()
	const list = new HistoryList({ theme: testTheme, onPick, onCancel, onShortcut })
	list.setItems([
		{ id: "a", label: "10:00  First chat  (1 question)", current: true },
		{ id: "b", label: "09:00  Second chat  (2 questions)", current: false },
		{ id: "c", label: "08:00  Third chat  (0 questions)", current: false },
	])
	const selectedLine = () =>
		list
			.render(60)
			.map((line) => stripTerminalSequences(line))
			.find((line) => line.startsWith("→"))
	return { list, onPick, onCancel, onShortcut, selectedLine }
}

describe("HistoryList", () => {
	it("lists every side chat and marks the open one", () => {
		const lines = setup()
			.list.render(60)
			.map((line) => stripTerminalSequences(line))
			.join("\n")

		expect(lines).toContain("First chat")
		expect(lines).toContain("Second chat")
		expect(lines).toContain("open")
	})

	it("opens the highlighted chat on enter", () => {
		const { list, onPick } = setup()

		list.handleInput(DOWN)
		list.handleInput(ENTER)

		expect(onPick).toHaveBeenCalledWith("b")
	})

	it("cancels on escape", () => {
		const { list, onCancel } = setup()

		list.handleInput(ESCAPE)

		expect(onCancel).toHaveBeenCalled()
	})

	it("moves the highlight with the wheel, clamped to the list", () => {
		const { list, selectedLine } = setup()

		list.scrollBy(1)
		expect(selectedLine()).toContain("Second chat")
		list.scrollBy(10)
		expect(selectedLine()).toContain("Third chat")
		list.scrollBy(-10)
		expect(selectedLine()).toContain("First chat")
	})

	it("lets extension shortcuts through before list navigation", () => {
		const onShortcut = vi.fn(() => true)
		const { list, onPick } = setup(onShortcut)

		list.handleInput(ENTER)

		expect(onShortcut).toHaveBeenCalledWith(ENTER)
		expect(onPick).not.toHaveBeenCalled()
	})
})
