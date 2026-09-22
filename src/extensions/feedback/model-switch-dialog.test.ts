import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { initTheme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { ModelSwitchComponent, showModelSwitchDialog } from "./model-switch-dialog.js"

beforeAll(() => {
	initTheme("default")
})

function makeTui(): TUI {
	return {
		requestRender: vi.fn(),
		terminal: { rows: 40, cols: 80 },
	} as unknown as TUI
}

function makeTheme(): Theme {
	return {
		fg: (_color: string, s: string) => s,
		bg: (_color: string, s: string) => s,
		bold: (s: string) => s,
		getFgAnsi: (_color: string) => "",
	} as unknown as Theme
}

function makeKeybindings(): KeybindingsManager {
	return {
		matches: (_data: string, _action: string) => false,
	} as unknown as KeybindingsManager
}

function makeComponent(modelName = "Concrete") {
	const done = vi.fn()
	const component = new ModelSwitchComponent(makeTui(), makeTheme(), makeKeybindings(), { modelName }, done)
	return { component, done }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: test-only helper
const ANSI_RE = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "")
}

const ENTER = "\r"
const ESCAPE = "\x1b"

describe("ModelSwitchComponent", () => {
	it("renders the model name, prompt, and hint", () => {
		const { component } = makeComponent("Opus 5")
		const text = component.render(80).map(stripAnsi).join("\n")
		expect(text).toContain("Model switch")
		expect(text).toContain("Switched to Opus 5")
		expect(text).toContain("Tell us why you switched to Opus 5")
		expect(text).toContain("[Enter] Submit")
		expect(text).toContain("[Esc] Cancel")
	})

	it("Enter submits the trimmed editor text", () => {
		const { component, done } = makeComponent()
		for (const ch of "  faster  ") {
			component.handleInput(ch)
		}
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "faster" })
	})

	it("Enter with no input submits an empty reason", () => {
		const { component, done } = makeComponent()
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "" })
	})

	it("Escape cancels without a result", () => {
		const { component, done } = makeComponent()
		component.handleInput("a")
		component.handleInput(ESCAPE)
		expect(done).toHaveBeenCalledWith(undefined)
	})

	it("digits are ordinary text in the reason field", () => {
		// Unlike the rating dialog there are no predefined options here, so a
		// digit is never a jump key.
		const { component, done } = makeComponent()
		for (const ch of "3x slower") {
			component.handleInput(ch)
		}
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "3x slower" })
	})
})

describe("showModelSwitchDialog", () => {
	it("opens as a centered overlay", async () => {
		const custom = vi.fn().mockResolvedValue({ reason: "because" })
		const ctx = { ui: { custom } } as unknown as ExtensionContext

		const result = await showModelSwitchDialog(ctx, { modelName: "Concrete" })

		expect(result).toEqual({ reason: "because" })
		expect(custom).toHaveBeenCalledTimes(1)
		expect(custom.mock.calls[0]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: { anchor: "center", width: "70%", maxHeight: "40%" },
		})
	})
})
