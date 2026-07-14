import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { renderTipRow, renderTipText, TipRow } from "./tip-row.js"
import type { TipCandidate } from "./types.js"

function theme(): Theme {
	return {
		fg: vi.fn((color: string, text: string) => {
			if (color === "accent") return `\x1b[36m${text}\x1b[39m`
			if (color === "dim") return `\x1b[2m${text}\x1b[22m`
			if (color === "success") return `\x1b[32m${text}\x1b[39m`
			if (color === "warning") return `\x1b[33m${text}\x1b[39m`
			if (color === "error") return `\x1b[31m${text}\x1b[39m`
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
	it("renders one left-aligned line within narrow, normal, and wide widths", () => {
		for (const width of [1, 4, 12, 40, 80, 120, 160]) {
			const lines = renderTipRow(tip, theme(), width)

			expect(lines).toHaveLength(1)
			expect(lines[0]).not.toContain("\n")
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width)
		}
	})

	it("caps visible content width without padding wider rows", () => {
		const [line] = renderTipRow(tip, theme(), 160)

		expect(line.startsWith(" ")).toBe(false)
		expect(visibleWidth(line)).toBeLessThanOrEqual(96)
	})

	it("keeps tip text anchored to the left edge at the current row position", () => {
		const [wideLine] = renderTipRow(tip, theme(), 120)
		const [narrowerLine] = renderTipRow(tip, theme(), 80)

		expect(wideLine.match(/^ */)?.[0].length).toBe(0)
		expect(narrowerLine.match(/^ */)?.[0].length).toBe(0)
		expect(wideLine).toBe(narrowerLine)
	})

	it("renders the Tip label with muted styling", () => {
		const [line] = renderTipRow(tip, theme(), 120)

		expect(line).toContain("\x1b[90mTip:\x1b[39m")
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

	it("renders a standalone tip message with the shared styling", () => {
		const [line] = renderTipText("Use `/ferment` anytime.", theme(), 120)

		expect(line).toContain("\x1b[90mTip:\x1b[39m")
		expect(line).toContain("\x1b[36m/ferment\x1b[39m")
		expect(line).not.toContain("`")
	})

	it("renders warning tips without the Tip prefix", () => {
		const [line] = renderTipRow(
			{
				source: "kimchi.billing",
				id: "billing-low",
				scope: "contextual",
				message: "Heads up: your credits are running low ($5 remaining).",
				tone: "warning",
				showPrefix: false,
			},
			theme(),
			120,
		)

		expect(line).not.toContain("Tip:")
		expect(line).toContain("\x1b[33mHeads up: your credits are running low ($5 remaining).\x1b[39m")
	})

	it("wraps standalone warning tips instead of truncating the billing URL", () => {
		const lines = renderTipRow(
			{
				source: "kimchi.billing",
				id: "billing-low",
				scope: "contextual",
				message:
					"Heads up: your credits are running low ($5 remaining). Top up now to avoid slowdowns and rate limits: https://app.kimchi.dev/billing",
				tone: "warning",
				showPrefix: false,
			},
			theme(),
			80,
		)

		expect(lines.length).toBeGreaterThan(1)
		expect(lines.join(" ")).toContain("https://app.kimchi.dev/billing")
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80)
		}
	})

	it("wraps standalone error tips instead of truncating the billing URL", () => {
		const lines = renderTipRow(
			{
				source: "kimchi.billing",
				id: "billing-exhausted",
				scope: "contextual",
				message:
					"You ran out of credits. Keep using Kimchi in restricted mode or top up at https://app.kimchi.dev/billing",
				tone: "error",
				showPrefix: false,
			},
			theme(),
			72,
		)

		expect(lines.length).toBeGreaterThan(1)
		expect(lines.join(" ")).toContain("https://app.kimchi.dev/billing")
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(72)
		}
	})
})
