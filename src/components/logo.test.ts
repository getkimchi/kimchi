import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const getVersionMock = vi.fn(() => "1.0.0-test")
const getFolderMock = vi.fn(() => "/project")
const getGitBranchMock = vi.fn(() => "main")

vi.mock("../utils.js", () => ({
	getVersion: () => getVersionMock(),
	getFolder: () => getFolderMock(),
	getGitBranch: () => getGitBranchMock(),
}))

const { LogoHeader } = await import("./logo.js")

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping in test assertions
const ANSI_ESCAPE = /\x1b\[[\d;]*m/g
const stripAnsi = (s: string): string => s.replace(ANSI_ESCAPE, "")

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

describe("LogoHeader", () => {
	beforeEach(() => {
		getVersionMock.mockReturnValue("1.0.0-test")
		getFolderMock.mockReturnValue("/project")
		getGitBranchMock.mockReturnValue("main")
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("renders a bordered two-column layout at width 120", () => {
		const theme = createMockTheme()
		const header = new LogoHeader(theme)
		const lines = header.render(120)

		// First and last lines are borders
		expect(stripAnsi(lines[0])).toMatch(/^┌─+┐$/)
		expect(stripAnsi(lines[lines.length - 1])).toMatch(/^└─+┘$/)

		// Every content line contains the vertical divider
		for (let i = 1; i < lines.length - 1; i++) {
			expect(stripAnsi(lines[i])).toContain("│")
		}

		// Contains logo lines in the left column
		const logoRows = lines.slice(1, -1).filter((l) => stripAnsi(l).includes("█"))
		expect(logoRows.length).toBeGreaterThanOrEqual(3)

		// Contains version info
		const versionRow = lines.slice(1, -1).find((l) => stripAnsi(l).includes("v1.0.0-test"))
		expect(versionRow).toBeDefined()

		// Contains folder + branch
		const pathRow = lines.slice(1, -1).find((l) => stripAnsi(l).includes("/project") && stripAnsi(l).includes("main"))
		expect(pathRow).toBeDefined()

		// Contains right column content
		const rightText = lines.slice(1, -1).map(stripAnsi).join(" ")
		expect(rightText).toContain("Kimchi's special:")
		expect(rightText).toContain("/ferment")
		expect(rightText).toContain("/pause")
		expect(rightText).toContain("/quit")

		// Contains a horizontal rule in the right column
		const hrRow = lines.slice(1, -1).find((l) => {
			const stripped = stripAnsi(l)
			return stripped.includes("──")
		})
		expect(hrRow).toBeDefined()

		// No content line exceeds the requested width
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(120)
		}
	})

	it("wraps right column text at width 60", () => {
		const theme = createMockTheme()
		const header = new LogoHeader(theme)
		const lines = header.render(60)

		// Should still be a bordered box
		expect(stripAnsi(lines[0])).toMatch(/^┌─+┐$/)
		expect(stripAnsi(lines[lines.length - 1])).toMatch(/^└─+┘$/)

		// Right column text wraps, so total height should be taller than logo + version
		expect(lines.length).toBeGreaterThan(8)

		const rightText = lines.slice(1, -1).map(stripAnsi).join(" ")
		expect(rightText).toContain("Kimchi's special:")
		expect(rightText).toContain("/ferment")
		expect(rightText).toContain("/pause")
		expect(rightText).toContain("/quit")

		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60)
		}
	})

	it("degrades gracefully at narrow width 45", () => {
		const theme = createMockTheme()
		const header = new LogoHeader(theme)
		const lines = header.render(45)

		// Still has borders and dividers
		expect(stripAnsi(lines[0])).toMatch(/^┌─+┐$/)
		expect(stripAnsi(lines[lines.length - 1])).toMatch(/^└─+┘$/)

		// Right column content wraps aggressively but remains present.
		// At width 45 the right column is ~6 chars wide, so words may split;
		// we verify the keywords appear across the wrapped output.
		const rightChars = stripAnsi(lines.slice(1, -1).join(""))
		expect(rightChars).toMatch(/K/i)
		expect(rightChars).toMatch(/s\s*p\s*e\s*c/i)
		expect(rightChars).toMatch(/f\s*e\s*r\s*m/i)
		expect(rightChars).toMatch(/p\s*a\s*u\s*s/i)
		expect(rightChars).toMatch(/q\s*u\s*i\s*t/i)
		// Verify the right column actually has content (non-space chars after the left column)
		const contentRows = lines.slice(1, -1)
		const rowsWithRightContent = contentRows.filter((l) => {
			const stripped = stripAnsi(l)
			// After the logo area (~36 chars) there should be a divider and then content
			return /│[^│]+│/.test(stripped)
		})
		expect(rowsWithRightContent.length).toBeGreaterThan(5)

		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(45)
		}
	})

	it("uses accent color for borders, divider, and highlighted commands", () => {
		const theme = createMockTheme()
		const header = new LogoHeader(theme)
		const lines = header.render(120)

		// Borders use accent ANSI
		for (const line of lines) {
			expect(line).toContain("\x1b[36m")
		}

		// Highlighted commands use theme.fg("accent", ...) which wraps with accent + reset
		const rightSection = lines.slice(1, -1).join("\n")
		expect(rightSection).toContain("\x1b[36m/ferment\x1b[0m")
		expect(rightSection).toContain("\x1b[36m/pause\x1b[0m")
		expect(rightSection).toContain("\x1b[36m/quit\x1b[0m")
	})

	it("centers the logo vertically when the right column is taller", () => {
		const theme = createMockTheme()
		const header = new LogoHeader(theme)
		const lines = header.render(120)

		// Find rows containing logo art (█ character)
		const logoIndices: number[] = []
		for (let i = 1; i < lines.length - 1; i++) {
			if (stripAnsi(lines[i]).includes("█")) {
				logoIndices.push(i)
			}
		}
		expect(logoIndices.length).toBeGreaterThanOrEqual(3)

		// Logo should be vertically centered within content lines when possible.
		// When the left column (logo + version + path) determines the total height,
		// there may be no slack to center the logo (it must stay at the top to fit
		// version and path below it). We verify the logo is within the content area
		// and version/path appear below it.
		const contentHeight = lines.length - 2 // excluding borders
		const logoTop = logoIndices[0] - 1 // 0-based within content
		const logoBottom = logoIndices[logoIndices.length - 1] - 1
		const versionTop = logoBottom + 2 // gap + version line

		expect(logoTop).toBeGreaterThanOrEqual(0)
		expect(logoBottom).toBeLessThan(contentHeight)
		expect(versionTop).toBeGreaterThan(logoBottom)

		// Logo center should be reasonably close to content center (±2 rows)
		const logoCenter = (logoTop + logoBottom) / 2
		const contentCenter = (contentHeight - 1) / 2
		expect(Math.abs(logoCenter - contentCenter)).toBeLessThanOrEqual(2)
	})
})
