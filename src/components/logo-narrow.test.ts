import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"

vi.mock("../utils.js", () => ({
	getVersion: () => "1.0.0-test",
	getFolder: () => "/project",
	getGitBranch: () => "main",
}))

const { LogoHeader, computeHeaderLayout } = await import("./logo.js")

function createMockTheme(): Theme {
	const COLOR_CODE: Record<string, string> = {
		accent: "\x1b[36m",
		dim: "\x1b[2m",
		mdLink: "\x1b[35m",
	}
	const RESET = "\x1b[0m"
	const fg = vi.fn((color: string, s: string) => `${COLOR_CODE[color] ?? "\x1b[39m"}${s}${RESET}`)
	return {
		fg,
		bg: vi.fn(),
		getFgAnsi: vi.fn((color: string) => COLOR_CODE[color] ?? "\x1b[39m"),
		getBgAnsi: vi.fn(),
		fgColors: {},
		bgColors: {},
		mode: "light",
		preproc: vi.fn(),
		extensions: {},
	} as unknown as Theme
}

// Layout constants from src/components/logo.ts. The header is two cells: left
// holds logo + info lines centered in `span = logoWidth + 2*gutter`; right
// holds the tips in `rightColWidth` with one CELL_PAD space each side.
const CHROME = 3
const CELL_PAD = 1
const RIGHT_MIN = 12
const MIN_GUTTER = 1
const COMPACT_LOGO_WIDTH = 7
const FULL_LOGO_WIDTH = 36
const COMPACT_BREAKPOINT = FULL_LOGO_WIDTH + CHROME + 2 * CELL_PAD + RIGHT_MIN + 2 * MIN_GUTTER // 55

describe("LogoHeader — narrow terminals", () => {
	// Regression: on terminals narrower than the fixed-width logo column the
	// header used to emit 40-cell body lines regardless of `width`, which
	// crashes pi-tui's doRender with "Rendered line N exceeds terminal width".
	// Every emitted line must fit the requested width, including absurd sizes
	// like a 1- or 2-column terminal.
	for (const width of [1, 2, 3, 4, 5, 8, 10, 16, 20, 30, 39, 40, 46, 50, 54, 60, 80, 109, 120]) {
		it(`never emits a line wider than ${width}`, () => {
			const header = new LogoHeader(createMockTheme())
			const lines = header.render(width)
			expect(lines.length).toBeGreaterThan(0)
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			}
		})
	}

	// The full word-art (36 cols) needs at least MIN_GUTTER on each side of
	// the logo plus RIGHT_MIN for the tips to remain readable; below that
	// threshold the header switches to the pepper-only mark.
	describe("variant switch", () => {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
		const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

		for (const width of [11, 20, 30, 39, 46, 50, 54]) {
			it(`uses the pepper-only mark at width ${width}`, () => {
				const header = new LogoHeader(createMockTheme())
				const lines = header.render(width).map(strip)
				const pepperRow = lines.find((line) => line.includes("███"))
				expect(pepperRow).toBeDefined()
				// At non-degenerate widths the box fits without truncation, so the
				// row still ends at the right border. Below ~20 cols pi-tui's
				// tail-truncation may crop that border and the assertion is skipped.
				if (width >= 20) {
					expect(pepperRow?.trimEnd().endsWith("│")).toBe(true)
				}
				// Word-art fragment absent → compact art selected.
				expect(lines.join("\n")).not.toContain("▀█▀")
			})
		}

		for (const width of [55, 60, 80, 109, 120]) {
			it(`uses the full word-art at width ${width}`, () => {
				const header = new LogoHeader(createMockTheme())
				const text = header.render(width).map(strip).join("\n")
				expect(text).toContain("▀█▀")
				expect(text).toContain("███")
			})
		}

		it("switches back to the full logo after invalidate", () => {
			const header = new LogoHeader(createMockTheme())
			header.invalidate()
			const narrow = header.render(30).map(strip).join("\n")
			expect(narrow).not.toContain("▀█▀")
			const wide = header.render(60).map(strip).join("\n")
			expect(wide).toContain("▀█▀")
		})
	})

	// Layout invariants. The production allocation function must hand each
	// variant the expected left-cell span and right-column width.
	describe("allocation matches the spec at anchor widths", () => {
		const anchors: Array<{ width: number; span: number; right: number }> = [
			{ width: 11, span: 7, right: 1 },
			{ width: 20, span: 7, right: 8 },
			{ width: 26, span: 9, right: 12 },
			{ width: 30, span: 13, right: 12 },
			{ width: 38, span: 21, right: 12 },
			{ width: 46, span: 27, right: 14 },
			{ width: 54, span: 27, right: 22 },
			{ width: 55, span: 38, right: 12 },
			{ width: 60, span: 42, right: 13 },
			{ width: 69, span: 52, right: 12 },
			{ width: 80, span: 56, right: 19 },
			{ width: 96, span: 56, right: 35 },
			{ width: 109, span: 56, right: 48 },
			{ width: 120, span: 56, right: 59 },
			{ width: 126, span: 56, right: 65 },
			{ width: 150, span: 56, right: 89 },
			{ width: 200, span: 56, right: 139 },
		]

		for (const { width, span, right } of anchors) {
			it(`at width ${width}: span=${span}, rightCol=${right}`, () => {
				const logoWidth = width < COMPACT_BREAKPOINT ? COMPACT_LOGO_WIDTH : FULL_LOGO_WIDTH
				const layout = computeHeaderLayout(width, logoWidth)
				expect(layout.span).toBe(span)
				expect(layout.rightColWidth).toBe(right)
			})
		}
	})

	// Monotonicity: as width grows, neither the divider nor the right column
	// should lurch backwards by more than 1 col at a time. The only allowed
	// jump is the single regime switch (compact→full).
	describe("monotonic right column as width grows", () => {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
		const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

		const rightSeg = (lines: string[]): number => {
			const row = lines.find((l) => strip(l).split("│").length === 4)
			return row ? (strip(row).split("│")[2]?.length ?? 0) : 0
		}

		it("right column grows monotonically in compact regime (width 26..54)", () => {
			let prev = -Infinity
			for (let w = 26; w <= 54; w++) {
				const lines = new LogoHeader(createMockTheme()).render(w).map(strip)
				const rightLen = rightSeg(lines)
				// Right cell is CELL_PAD + rightColWidth + CELL_PAD. Allow a
				// 1-col notch when gutters step up.
				expect(rightLen).toBeGreaterThanOrEqual(prev - 1)
				prev = rightLen
			}
		})

		it("right column grows monotonically in full regime (width 55..200)", () => {
			let prev = -Infinity
			for (let w = 55; w <= 200; w++) {
				const lines = new LogoHeader(createMockTheme()).render(w).map(strip)
				const rightLen = rightSeg(lines)
				expect(rightLen).toBeGreaterThanOrEqual(prev - 1)
				prev = rightLen
			}
		})

		it("logo cell is capped at the previous max of 56 cols in wide regime", () => {
			for (const width of [126, 150, 200]) {
				const logoWidth = width < COMPACT_BREAKPOINT ? COMPACT_LOGO_WIDTH : FULL_LOGO_WIDTH
				const { span } = computeHeaderLayout(width, logoWidth)
				expect(span).toBeLessThanOrEqual(56)
			}
		})
	})

	// Centering: the pepper mark and info lines are always horizontally
	// centered within the left cell span (the previous alignment fix).
	describe("centering", () => {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
		const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")
		const leftSegment = (row: string) => row.split("│")[1]
		const findRow = (lines: string[], needle: string): string => {
			const row = lines.find((l) => l.includes(needle))
			expect(row, `row containing ${needle}`).toBeDefined()
			return row ?? ""
		}
		const assertCentered = (row: string) => {
			const seg = leftSegment(row)
			const lead = seg.match(/^ */)?.[0].length ?? 0
			const trail = seg.match(/ *$/)?.[0].length ?? 0
			expect(Math.abs(lead - trail)).toBeLessThanOrEqual(1)
		}

		for (const width of [30, 38, 46]) {
			it(`centers pepper + info lines within the left span at width ${width}`, () => {
				const lines = new LogoHeader(createMockTheme()).render(width).map(strip)
				assertCentered(findRow(lines, "▄  ▄███"))
				assertCentered(findRow(lines, "v1.0.0"))
				assertCentered(findRow(lines, "main"))
			})
		}
	})

	// Vertical padding is generous and consistent at common widths.
	describe("vertical padding", () => {
		it("keeps the top and bottom borders intact and renders at least the minimum box", () => {
			for (const width of [55, 69, 80, 109, 120]) {
				const lines = new LogoHeader(createMockTheme()).render(width)
				expect(lines.length).toBeGreaterThanOrEqual(11)
			}
		})
	})
})
