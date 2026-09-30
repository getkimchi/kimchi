import type { Theme } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createStatusPanelComponent } from "./panel.js"

function makeTheme(): Theme {
	return {
		fg: (_tone: string, s: string) => s,
		bold: (s: string) => s,
	} as unknown as Theme
}

describe("createStatusPanelComponent", () => {
	it("renders the title, all rows, separator preserved, and a close hint", () => {
		const rows = [
			"Version:        1.2.3",
			"Login method:   Kimchi account",
			"",
			"Model:          anthropic/claude-sonnet-4-5",
		]
		const panel = createStatusPanelComponent(makeTheme(), rows, () => {})
		const lines = panel.render(60)
		expect(lines.join("\n")).toContain("Status")
		expect(lines.join("\n")).toContain("Version:        1.2.3")
		expect(lines.join("\n")).toContain("Model:          anthropic/claude-sonnet-4-5")
		expect(lines.join("\n")).toContain("press any key to close")
		// blank row between blocks survives
		expect(lines).toContain("")
	})

	it("calls done on any key press", () => {
		const done = vi.fn()
		const panel = createStatusPanelComponent(makeTheme(), [], done)
		expect(panel.handleInput).toBeDefined()
		panel.handleInput?.("x")
		expect(done).toHaveBeenCalledTimes(1)
		panel.handleInput?.("\u001b") // Esc
		expect(done).toHaveBeenCalledTimes(2)
	})

	it("caches rendered lines per width and invalidates on demand", () => {
		const panel = createStatusPanelComponent(makeTheme(), ["Version:        1.2.3"], () => {})
		const first = panel.render(40)
		expect(panel.render(40)).toBe(first)
		expect(panel.render(80)).not.toBe(first)
		panel.invalidate()
		expect(panel.render(40)).not.toBe(first)
	})
})
