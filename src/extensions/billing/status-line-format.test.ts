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
	it("formats billing footer tones without alert colors", () => {
		const t = theme()

		expect(formatBillingStatusLine({ text: "Community: €2", tone: "dim" }, t)).toBe("<dim>Community: €2</dim>")
		expect(formatBillingStatusLine({ text: "Coder: €10", tone: "accent" }, t)).toBe(`<accent>Coder: €10${RST_FG}`)
	})
})
