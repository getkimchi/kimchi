import type { Theme } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import {
	SESSION_MODE_PICKER_HEADING,
	SESSION_MODE_PICKER_HIDE_LABEL,
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
	it("starts on Ferment session", () => {
		expect(initialSessionModePickerState()).toEqual({ selectedIndex: 0, hideDialog: false })
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

	it("supports the returning-launch hide checkbox", () => {
		let state = initialSessionModePickerState()

		state = reduceSessionModePicker(state, "down", { showHideCheckbox: true }).state
		state = reduceSessionModePicker(state, "down", { showHideCheckbox: true }).state
		expect(state.selectedIndex).toBe(1)

		state = reduceSessionModePicker(state, "toggle-hide", { showHideCheckbox: true }).state
		expect(state.hideDialog).toBe(true)
		expect(reduceSessionModePicker(state, "select", { showHideCheckbox: true }).result).toEqual({
			choice: "default",
			hideDialog: true,
		})
	})

	it("returns the selected option on select", () => {
		let state = initialSessionModePickerState()
		expect(reduceSessionModePicker(state, "select").result).toEqual({ choice: "ferment", hideDialog: false })

		state = reduceSessionModePicker(state, "down").state
		expect(reduceSessionModePicker(state, "select").result).toEqual({ choice: "default", hideDialog: false })
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
		expect(keyToSessionModePickerEvent(" ")).toBe("toggle-hide")
		expect(keyToSessionModePickerEvent("\x1b")).toBe("cancel")
		expect(keyToSessionModePickerEvent("\x03")).toBe("cancel")
	})

	it("ignores unrelated input", () => {
		expect(keyToSessionModePickerEvent("x")).toBeUndefined()
	})

	it("ignores space repeat and release events", () => {
		expect(keyToSessionModePickerEvent("\x1b[32;1:2u")).toBeUndefined()
		expect(keyToSessionModePickerEvent("\x1b[32;1:3u")).toBeUndefined()
	})
})

describe("session mode picker rendering", () => {
	it("renders the exact PRD copy", () => {
		const lines = renderSessionModePickerLines(initialSessionModePickerState(), theme(), 100)
		const text = lines.join("\n")

		expect(text).toContain(SESSION_MODE_PICKER_HEADING)
		expect(text).toContain("Ferment session")
		expect(text).toContain("Agent runs the full task end-to-end. You review the result.")
		expect(text).toContain("Default session")
		expect(text).toContain("Standard coding harness experience outside of the active ferment.")
		expect(text).not.toContain(SESSION_MODE_PICKER_HIDE_LABEL)
		expect(text).not.toContain("Tip:")
	})

	it("renders the hide checkbox only when requested", () => {
		const lines = renderSessionModePickerLines(initialSessionModePickerState(), theme(), 100, {
			showHideCheckbox: true,
		})
		const text = lines.join("\n")

		expect(text).toContain(`[ ] ${SESSION_MODE_PICKER_HIDE_LABEL}`)
	})

	it("marks the selected option", () => {
		let lines = renderSessionModePickerLines(initialSessionModePickerState(), theme(), 100)
		expect(lines.some((line) => line.includes("> Ferment session"))).toBe(true)
		expect(lines.some((line) => line.includes("> Default session"))).toBe(false)

		const state = reduceSessionModePicker(initialSessionModePickerState(), "down").state
		lines = renderSessionModePickerLines(state, theme(), 100)
		expect(lines.some((line) => line.includes("> Default session"))).toBe(true)
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
		expect(onDone).toHaveBeenCalledWith({ choice: "default", hideDialog: false })
	})

	it("handles the hide checkbox when enabled", () => {
		const onDone = vi.fn()
		const component = new SessionModePickerComponent(theme(), onDone, vi.fn(), { showHideCheckbox: true })

		component.handleInput(" ")
		component.handleInput("\x1b[32;1:3u")
		component.handleInput("\x1b[B")
		component.handleInput("\r")

		expect(onDone).toHaveBeenCalledWith({ choice: "default", hideDialog: true })
	})

	it("calls onDone for cancellation", () => {
		const onDone = vi.fn()
		const component = new SessionModePickerComponent(theme(), onDone, vi.fn())

		component.handleInput("\x03")

		expect(onDone).toHaveBeenCalledWith("cancelled")
	})
})
