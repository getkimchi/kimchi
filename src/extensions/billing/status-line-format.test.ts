import type { Theme } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { RST_FG } from "../../ansi.js"
import { formatBudgetStatusLine, formatCreditsStatusLine } from "./status-line-format.js"

function theme(): Theme {
	return {
		fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
		bg: vi.fn((_color: string, text: string) => text),
		bold: vi.fn((text: string) => text),
		getFgAnsi: vi.fn((color: string) => `<${color}>`),
		getBgAnsi: vi.fn(),
		fgColors: {},
		bgColors: {},
		mode: "dark",
		preproc: vi.fn(),
		extensions: {},
	} as unknown as Theme
}

describe("billing status line format", () => {
	it("dims the fixed label and accents the dollar balance", () => {
		const t = theme()

		expect(formatCreditsStatusLine("$10.00", t)).toBe(`<dim>Credits:</dim> <accent>$10.00${RST_FG}`)
	})

	it("formats budget independently from credits", () => {
		const t = theme()

		expect(formatBudgetStatusLine("13.73% ($274.59/$2k)", t)).toBe(
			`<dim>Budget:</dim> <accent>13.73% ($274.59/$2k)${RST_FG}`,
		)
	})
})
