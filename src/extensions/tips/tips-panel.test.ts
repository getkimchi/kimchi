import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { createTipsPanel, sourceToLabel } from "./tips-panel.js"
import type { TipCandidate } from "./types.js"

function plainTheme(): Theme {
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

function makeTip(id: string, message: string, source = "kimchi.general"): TipCandidate {
	return { id, message, scope: "general", source }
}

function makeTui(rows = 40) {
	return { requestRender: vi.fn(), terminal: { rows } }
}

describe("sourceToLabel", () => {
	it("maps known sources", () => {
		expect(sourceToLabel("kimchi.general")).toBe("General")
		expect(sourceToLabel("kimchi.ferment")).toBe("Ferment")
	})

	it("strips kimchi prefix and capitalizes unknown sources", () => {
		expect(sourceToLabel("kimchi.custom")).toBe("Custom")
	})

	it("capitalizes sources without kimchi prefix", () => {
		expect(sourceToLabel("external")).toBe("External")
	})
})

describe("createTipsPanel", () => {
	describe("render", () => {
		it("renders numbered tips grouped by source", () => {
			const tips = [
				makeTip("a", "First tip.", "kimchi.general"),
				makeTip("b", "Second tip.", "kimchi.general"),
				makeTip("c", "Ferment tip.", "kimchi.ferment"),
			]
			const panel = createTipsPanel(tips, plainTheme(), makeTui(), vi.fn())
			const lines = panel.render(60)
			const text = lines.join("\n")

			expect(text).toContain("Tips")
			expect(text).toContain("General")
			expect(text).toContain("1. First tip.")
			expect(text).toContain("2. Second tip.")
			expect(text).toContain("Ferment")
			expect(text).toContain("3. Ferment tip.")
		})

		it("renders an empty state when no tips are provided", () => {
			const panel = createTipsPanel([], plainTheme(), makeTui(), vi.fn())
			const lines = panel.render(60)
			const text = lines.join("\n")

			expect(text).toContain("No tips available.")
		})

		it("respects panel width and does not exceed it", () => {
			const tips = [makeTip("a", "A short tip.")]
			const panel = createTipsPanel(tips, plainTheme(), makeTui(), vi.fn())
			const width = 50
			const lines = panel.render(width)

			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			}
		})

		it("wraps long tip messages across multiple lines", () => {
			const longMsg =
				"This is a very long tip message that should definitely wrap across multiple lines when the panel width is narrow enough to trigger word wrapping."
			const tips = [makeTip("long", longMsg)]
			const panel = createTipsPanel(tips, plainTheme(), makeTui(), vi.fn())
			const lines = panel.render(50)

			// The tip content should appear across more than just the header+1 line
			const tipLines = lines.filter((l) => l.includes("1.") || l.includes("  "))
			expect(tipLines.length).toBeGreaterThan(1)
		})

		it("shows search bar placeholder when no query", () => {
			const tips = [makeTip("a", "Some tip.")]
			const panel = createTipsPanel(tips, plainTheme(), makeTui(), vi.fn())
			const lines = panel.render(60)
			const text = lines.join("\n")

			expect(text).toContain("search...")
		})
	})

	describe("handleInput — close", () => {
		it("calls done on Esc with no search", () => {
			const done = vi.fn()
			const panel = createTipsPanel([makeTip("a", "Tip.")], plainTheme(), makeTui(), done)

			panel.handleInput("\x1b")
			expect(done).toHaveBeenCalledOnce()
		})

		it("calls done on Ctrl+C", () => {
			const done = vi.fn()
			const panel = createTipsPanel([makeTip("a", "Tip.")], plainTheme(), makeTui(), done)

			panel.handleInput("\x03")
			expect(done).toHaveBeenCalledOnce()
		})

		it("treats q as search character, not close shortcut", () => {
			const done = vi.fn()
			const panel = createTipsPanel([makeTip("a", "Tip.")], plainTheme(), makeTui(), done)

			panel.handleInput("q")
			expect(done).not.toHaveBeenCalled()
		})

		it("calls done on Enter with no search", () => {
			const done = vi.fn()
			const panel = createTipsPanel([makeTip("a", "Tip.")], plainTheme(), makeTui(), done)

			panel.handleInput("\r")
			expect(done).toHaveBeenCalledOnce()
		})
	})

	describe("handleInput — search", () => {
		it("filters tips based on search query", () => {
			const tips = [
				makeTip("a", "Press `shift+tab` to change permissions."),
				makeTip("b", "Run `/settings` to change colors."),
			]
			const panel = createTipsPanel(tips, plainTheme(), makeTui(), vi.fn())

			// Type "perm" to search
			for (const c of "perm") panel.handleInput(c)

			const lines = panel.render(60)
			const text = lines.join("\n")
			expect(text).toContain("permissions")
			expect(text).not.toContain("colors")
		})

		it("shows empty message when search has no matches", () => {
			const tips = [makeTip("a", "Some tip.")]
			const panel = createTipsPanel(tips, plainTheme(), makeTui(), vi.fn())

			for (const c of "zzzzz") panel.handleInput(c)

			const lines = panel.render(60)
			const text = lines.join("\n")
			expect(text).toContain("No tips available.")
		})

		it("clears search on first Esc and closes on second Esc", () => {
			const done = vi.fn()
			const tips = [makeTip("a", "Some tip.")]
			const panel = createTipsPanel(tips, plainTheme(), makeTui(), done)

			// Type search query
			panel.handleInput("x")

			// First Esc clears search
			panel.handleInput("\x1b")
			expect(done).not.toHaveBeenCalled()

			// Verify search is cleared — tip should be visible again
			const lines = panel.render(60)
			expect(lines.join("\n")).toContain("Some tip.")

			// Second Esc closes
			panel.handleInput("\x1b")
			expect(done).toHaveBeenCalledOnce()
		})

		it("does not close on q or Enter while search is active", () => {
			const done = vi.fn()
			const tips = [makeTip("a", "Some tip.")]
			const panel = createTipsPanel(tips, plainTheme(), makeTui(), done)

			// Type 'q' as search character
			panel.handleInput("q")
			expect(done).not.toHaveBeenCalled()

			// Enter while search is active does not close
			panel.handleInput("\r")
			expect(done).not.toHaveBeenCalled()
		})

		it("backspace removes from search query", () => {
			const tips = [makeTip("a", "Alpha tip."), makeTip("b", "Beta tip.")]
			const panel = createTipsPanel(tips, plainTheme(), makeTui(), vi.fn())

			// Type "alph" — only Alpha matches
			for (const c of "alph") panel.handleInput(c)
			let text = panel.render(60).join("\n")
			expect(text).toContain("Alpha")
			expect(text).not.toContain("Beta")

			// Backspace 4 times to clear — both show again
			for (let i = 0; i < 4; i++) panel.handleInput("\x7f")
			text = panel.render(60).join("\n")
			expect(text).toContain("Alpha")
			expect(text).toContain("Beta")
		})

		it("handles Kitty protocol CSI-u printable sequences", () => {
			const tips = [
				makeTip("a", "Press `shift+tab` to change permissions."),
				makeTip("b", "Run `/settings` to change colors."),
			]
			const panel = createTipsPanel(tips, plainTheme(), makeTui(), vi.fn())

			// Kitty protocol sends \x1b[<codepoint>u for printable characters
			panel.handleInput("\x1b[112u") // 'p'
			panel.handleInput("\x1b[101u") // 'e'
			panel.handleInput("\x1b[114u") // 'r'

			const lines = panel.render(60)
			const text = lines.join("\n")
			expect(text).toContain("permissions")
			expect(text).not.toContain("colors")
		})
	})

	describe("handleInput — scrolling", () => {
		it("scrolls down and up with arrow keys", () => {
			// Create enough tips to require scrolling on a small terminal
			const tips = Array.from({ length: 30 }, (_, i) => makeTip(`t${i}`, `Tip number ${i + 1}.`))
			const panel = createTipsPanel(tips, plainTheme(), makeTui(15), vi.fn())

			const linesBefore = panel.render(60)
			// Scroll down
			panel.handleInput("\x1b[B") // down arrow
			const linesAfter = panel.render(60)

			// The content should have shifted (first visible line changes)
			expect(linesAfter).not.toEqual(linesBefore)
		})
	})

	describe("grouping", () => {
		it("groups tips from different providers under separate headers", () => {
			const tips = [
				makeTip("a", "General tip.", "kimchi.general"),
				makeTip("b", "Ferment tip.", "kimchi.ferment"),
				makeTip("c", "Custom tip.", "kimchi.custom"),
			]
			const panel = createTipsPanel(tips, plainTheme(), makeTui(), vi.fn())
			const text = panel.render(60).join("\n")

			expect(text).toContain("General")
			expect(text).toContain("Ferment")
			expect(text).toContain("Custom")
		})

		it("hides empty groups when search filters out all their tips", () => {
			const tips = [
				makeTip("a", "Press shift to do things.", "kimchi.general"),
				makeTip("b", "Ferment specific tip.", "kimchi.ferment"),
			]
			const panel = createTipsPanel(tips, plainTheme(), makeTui(), vi.fn())

			// Search for "ferment" — general group should be hidden
			for (const c of "ferment") panel.handleInput(c)
			const text = panel.render(60).join("\n")

			expect(text).toContain("Ferment")
			expect(text).not.toContain("General")
		})
	})
})
