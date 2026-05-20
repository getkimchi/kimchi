import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { TipRow, renderTipRow } from "./tip-row.js"
import type { TipCandidate } from "./types.js"

function theme(): Theme {
	return {
		fg: vi.fn((color: string, text: string) => {
			if (color === "accent") return `\x1b[36m${text}\x1b[39m`
			if (color === "dim") return `\x1b[2m${text}\x1b[22m`
			return `\x1b[90m${text}\x1b[39m`
		}),
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

const tip: TipCandidate = {
	source: "test.general",
	id: "export",
	scope: "general",
	message: "Run `/export` to save this session as HTML.",
}

describe("TipRow", () => {
	it("renders one right-aligned line within narrow, normal, and wide widths", () => {
		for (const width of [1, 4, 12, 40, 80, 120, 160]) {
			const lines = renderTipRow(tip, theme(), width)

			expect(lines).toHaveLength(1)
			expect(lines[0]).not.toContain("\n")
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width)
		}
	})

	it("caps visible content width and pads wider rows to the right edge", () => {
		const [line] = renderTipRow(tip, theme(), 160)

		expect(line.startsWith(" ")).toBe(true)
		expect(visibleWidth(line)).toBe(160)
	})

	it("renders nothing when no tip is selected", () => {
		const row = new TipRow(() => undefined, theme())

		expect(row.render(80)).toEqual([])
	})

	it("highlights every markdown inline-code span and strips the delimiters", () => {
		const [line] = renderTipRow(
			{
				source: "test.contextual",
				id: "policy",
				scope: "contextual",
				message: "Use `/ferment auto` or `/ferment manual`.",
			},
			theme(),
			120,
		)

		expect(line).toContain("\x1b[36m/ferment auto\x1b[39m")
		expect(line).toContain("\x1b[36m/ferment manual\x1b[39m")
		expect(line).not.toContain("`")
	})
})
