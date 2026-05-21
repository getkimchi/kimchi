import type { Theme } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import {
	SESSION_MODE_PICKER_HEADING,
	SESSION_MODE_PICKER_HINT,
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
		state = reduceSessionModePicker(state, "down").state
		expect(state.selectedIndex).toBe(2)
	})

	it("returns the selected option on select", () => {
		let state = initialSessionModePickerState()
		expect(reduceSessionModePicker(state, "select").result).toEqual({ choice: "ferment", hideDialog: false })

		state = reduceSessionModePicker(state, "down").state
		expect(reduceSessionModePicker(state, "select").result).toEqual({ choice: "default", hideDialog: false })

		state = reduceSessionModePicker(state, "down").state
		expect(reduceSessionModePicker(state, "select").result).toEqual({ choice: "default", hideDialog: true })
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
	it("renders the workflow copy and bottom hint", () => {
		const lines = renderSessionModePickerLines(initialSessionModePickerState(), theme(), 140)
		const text = lines.join("\n")

		expect(lines).toEqual([
			"",
			"  Choose your workflow",
			"",
			"  > Ferment",
			"    Start a new ferment workflow. Agent plans and executes multi-step tasks end-to-end. You review the result.",
			"",
			"    Coding session",
			"    Chat with the agent and steer it as it goes. Stay in the loop.",
			"",
			"    Coding session, don't show this dialog again",
			"",
			"  Tip: Use /ferment anytime to start a Ferment workflow.",
			"",
		])
		expect(text).toContain(SESSION_MODE_PICKER_HEADING)
		expect(text).toContain("Ferment")
		expect(text).toContain(
			"Start a new ferment workflow. Agent plans and executes multi-step tasks end-to-end. You review the result.",
		)
		expect(text).toContain("Coding session")
		expect(text).toContain("Chat with the agent and steer it as it goes. Stay in the loop.")
		expect(text).toContain("Coding session, don't show this dialog again")
		expect(text).toContain(`Tip: ${SESSION_MODE_PICKER_HINT.replaceAll("`", "")}`)
	})

	it("marks the selected option", () => {
		let lines = renderSessionModePickerLines(initialSessionModePickerState(), theme(), 100)
		expect(lines.some((line) => line.includes("> Ferment"))).toBe(true)
		expect(lines.some((line) => line.includes("> Coding session"))).toBe(false)

		const state = reduceSessionModePicker(initialSessionModePickerState(), "down").state
		lines = renderSessionModePickerLines(state, theme(), 100)
		expect(lines.some((line) => line.includes("> Coding session"))).toBe(true)

		const hiddenState = reduceSessionModePicker(state, "down").state
		lines = renderSessionModePickerLines(hiddenState, theme(), 100)
		expect(lines.some((line) => line.includes("> Coding session, don't show this dialog again"))).toBe(true)
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

	it("handles the hide dialog option", () => {
		const onDone = vi.fn()
		const component = new SessionModePickerComponent(theme(), onDone, vi.fn())

		component.handleInput("\x1b[B")
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
