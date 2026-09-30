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
			"Model:          kimchi-dev/kimi-k3",
		]
		const panel = createStatusPanelComponent(makeTheme(), rows, () => {})
		const lines = panel.render(60)
		expect(lines.join("\n")).toContain("Status")
		expect(lines.join("\n")).toContain("Version:        1.2.3")
		expect(lines.join("\n")).toContain("Model:          kimchi-dev/kimi-k3")
		expect(lines.join("\n")).toContain("press any key to close")
		// blank row between blocks survives (wrapped in side borders)
		expect(lines.some((line) => /^│\s*│$/.test(line))).toBe(true)
	})

	it("draws a bordered box: corner rules and │ side borders on every row", () => {
		const panel = createStatusPanelComponent(makeTheme(), ["Version:        1.2.3"], () => {})
		const lines = panel.render(60)
		expect(lines[0]).toBe(`╭${"─".repeat(58)}╮`)
		expect(lines.at(-1)).toBe(`╰${"─".repeat(58)}╯`)
		for (const line of lines.slice(1, -1)) {
			expect(line.startsWith("│ ")).toBe(true)
			expect(line.endsWith(" │")).toBe(true)
			expect(line).toHaveLength(60)
		}
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
