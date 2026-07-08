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
	it("formats billing footer tones", () => {
		const t = theme()

		expect(formatBillingStatusLine({ text: "Community", tone: "dim" }, t)).toBe("<dim>Community</dim>")
		expect(formatBillingStatusLine({ text: "Coder: €10", tone: "accent" }, t)).toBe(`<accent>Coder: €10${RST_FG}`)
		expect(formatBillingStatusLine({ text: "Coder: €5", tone: "warning" }, t)).toBe(`<warning>Coder: €5${RST_FG}`)
		expect(formatBillingStatusLine({ text: "Coder: €0", tone: "error" }, t)).toBe(`<error>Coder: €0${RST_FG}`)
	})
})
