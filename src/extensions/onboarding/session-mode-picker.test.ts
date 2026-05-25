import type { Theme } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import {
	SessionModePickerComponent,
	initialSessionModePickerState,
	keyToSessionModePickerEvent,
	reduceSessionModePicker,
	renderSessionModePickerLines,
} from "./session-mode-picker.js"

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

describe("session mode picker reducer", () => {
	it("starts on Ferment", () => {
		expect(initialSessionModePickerState()).toEqual({ selectedIndex: 0 })
	})

	it("moves selection down and up", () => {
		let state = initialSessionModePickerState()
		state = reduceSessionModePicker(state, "down").state
		expect(state.selectedIndex).toBe(1)
		state = reduceSessionModePicker(state, "up").state
		expect(state.selectedIndex).toBe(0)
	})

	it("keeps selection stable at list boundaries", () => {
		let state = initialSessionModePickerState()
		state = reduceSessionModePicker(state, "up").state
		expect(state.selectedIndex).toBe(0)
		state = reduceSessionModePicker(state, "down").state
		state = reduceSessionModePicker(state, "down").state
		expect(state.selectedIndex).toBe(1)
	})

	it("returns the selected option on select", () => {
		let state = initialSessionModePickerState()
		expect(reduceSessionModePicker(state, "select").result).toBe("ferment")

		state = reduceSessionModePicker(state, "down").state
		expect(reduceSessionModePicker(state, "select").result).toBe("default")
	})

	it("returns cancellation on cancel", () => {
		expect(reduceSessionModePicker(initialSessionModePickerState(), "cancel").result).toBe("cancelled")
	})
})

describe("session mode picker key mapping", () => {
	it("maps navigation, selection, and cancellation keys", () => {
		expect(keyToSessionModePickerEvent("\x1b[A")).toBe("up")
		expect(keyToSessionModePickerEvent("\x1b[B")).toBe("down")
		expect(keyToSessionModePickerEvent("\r")).toBe("select")
		expect(keyToSessionModePickerEvent("\x1b")).toBe("cancel")
		expect(keyToSessionModePickerEvent("\x03")).toBe("cancel")
	})

	it("ignores unrelated input", () => {
		expect(keyToSessionModePickerEvent("x")).toBeUndefined()
	})

	it("ignores space input", () => {
		expect(keyToSessionModePickerEvent(" ")).toBeUndefined()
		expect(keyToSessionModePickerEvent("\x1b[32;1:2u")).toBeUndefined()
		expect(keyToSessionModePickerEvent("\x1b[32;1:3u")).toBeUndefined()
	})
})

describe("session mode picker rendering", () => {
	it("renders the two workflow options with no heading or tip", () => {
		const lines = renderSessionModePickerLines(initialSessionModePickerState(), theme(), 140)
		const text = lines.join("\n")

		expect(lines).toEqual([
			"",
			"  > Try a /ferment workflow",
			"    The agent breaks the task into milestones, self-evaluates its output and delivers with minimal interruptions.",
			"",
			"    Skip",
			"",
		])
		expect(text).toContain("Try a /ferment workflow")
		expect(text).toContain(
			"The agent breaks the task into milestones, self-evaluates its output and delivers with minimal interruptions.",
		)
		expect(text).toContain("Skip")
		expect(text).not.toContain("Tip:")
	})

	it("marks the selected option", () => {
		let lines = renderSessionModePickerLines(initialSessionModePickerState(), theme(), 100)
		expect(lines.some((line) => line.includes("> Try a /ferment workflow"))).toBe(true)
		expect(lines.some((line) => line.includes("> Skip"))).toBe(false)

		const state = reduceSessionModePicker(initialSessionModePickerState(), "down").state
		lines = renderSessionModePickerLines(state, theme(), 100)
		expect(lines.some((line) => line.includes("> Skip"))).toBe(true)
	})
})

describe("SessionModePickerComponent", () => {
	it("handles keys and calls onDone for selection", () => {
		const onDone = vi.fn()
		const requestRender = vi.fn()
		const component = new SessionModePickerComponent(theme(), onDone, requestRender)

		component.handleInput("\x1b[B")
		expect(component.getState().selectedIndex).toBe(1)
		expect(requestRender).toHaveBeenCalledTimes(1)

		component.handleInput("\r")
		expect(onDone).toHaveBeenCalledWith("default")
	})

	it("calls onDone for cancellation", () => {
		const onDone = vi.fn()
		const component = new SessionModePickerComponent(theme(), onDone, vi.fn())

		component.handleInput("\x03")

		expect(onDone).toHaveBeenCalledWith("cancelled")
	})
})
