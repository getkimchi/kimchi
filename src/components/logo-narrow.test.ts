import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"

vi.mock("../utils.js", () => ({
	getVersion: () => "1.0.0-test",
	getFolder: () => "/project",
	getGitBranch: () => "main",
}))

const { LogoHeader } = await import("./logo.js")

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

describe("LogoHeader — narrow terminals", () => {
	// Regression: on terminals narrower than the fixed-width logo column the
	// header used to emit 40-cell body lines regardless of `width`, which
	// crashes pi-tui's doRender with "Rendered line N exceeds terminal width".
	// Every emitted line must fit the requested width, including absurd sizes
	// like a 1- or 2-column terminal.
	for (const width of [1, 2, 3, 4, 5, 8, 10, 16, 20, 30, 39, 40]) {
		it(`never emits a line wider than ${width}`, () => {
			const header = new LogoHeader(createMockTheme())
			const lines = header.render(width)
			expect(lines.length).toBeGreaterThan(0)
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			}
		})
	}
})
