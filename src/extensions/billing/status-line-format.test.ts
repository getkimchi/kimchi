import type { Theme } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { RST_FG } from "../../ansi.js"
import { formatBillingStatusLine } from "./status-line-format.js"

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

describe("formatBillingStatusLine", () => {
	it("dims the fixed label and accents the dollar balance", () => {
		const t = theme()

		expect(formatBillingStatusLine({ amount: "$10.00" }, t)).toBe(`<dim>Credits:</dim> <accent>$10.00${RST_FG}`)
	})

	it("shows credits and budget together", () => {
		const t = theme()

		expect(formatBillingStatusLine({ amount: "$18.40", budget: "$274.59/$2k" }, t)).toBe(
			`<dim>Credits:</dim> <accent>$18.40${RST_FG}<dim> · </dim><dim>Budget:</dim> <accent>$274.59/$2k${RST_FG}`,
		)
	})
})
