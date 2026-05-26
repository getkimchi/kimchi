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

		// Contains a single combined info line with version, folder, and branch
		const infoRow = lines
			.slice(1, -1)
			.find(
				(l) =>
					stripAnsi(l).includes("v1.0.0-test") && stripAnsi(l).includes("/project") && stripAnsi(l).includes("main"),
			)
		expect(infoRow).toBeDefined()

		// Box should be taller due to generous vertical padding
		expect(lines.length).toBeGreaterThan(11)

		// Contains right column content
		const rightText = lines.slice(1, -1).map(stripAnsi).join(" ")
		expect(rightText).toContain("Kimchi's special:")
		expect(rightText).toContain("/ferment")
		expect(rightText).toContain("exit")

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
		expect(rightText).toContain("Kimchi")
		expect(rightText).toContain("special")
		expect(rightText).toContain("ferment")
		expect(rightText).toContain("exit")

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
		const rightChars = stripAnsi(lines.slice(1, -1).join(""))
		expect(rightChars).toMatch(/K/i)
		expect(rightChars).toMatch(/s\s*p\s*e\s*c/i)
		expect(rightChars).toMatch(/f\s*e\s*r\s*m/i)
		expect(rightChars).toMatch(/e\s*x\s*i\s*t/i)
		const contentRows = lines.slice(1, -1)
		const rowsWithRightContent = contentRows.filter((l) => {
			const stripped = stripAnsi(l)
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
		expect(rightSection).toContain("\x1b[36m/ferment exit\x1b[0m")
	})

	it("centers the logo and info line vertically as a unit", () => {
		const theme = createMockTheme()
		const header = new LogoHeader(theme)
		const lines = header.render(120)

		const contentHeight = lines.length - 2 // excluding borders

		// Find logo rows
		const logoIndices: number[] = []
		for (let i = 1; i < lines.length - 1; i++) {
			if (stripAnsi(lines[i]).includes("█")) {
				logoIndices.push(i)
			}
		}
		expect(logoIndices.length).toBeGreaterThanOrEqual(3)

		// Find combined info row
		const infoIndex = lines.findIndex(
			(l) => stripAnsi(l).includes("v1.0.0-test") && stripAnsi(l).includes("/project") && stripAnsi(l).includes("main"),
		)
		expect(infoIndex).toBeGreaterThan(0)

		const logoTop = logoIndices[0] - 1
		const infoRow = infoIndex - 1

		// There should be a gap between logo bottom and info row
		const logoBottom = logoIndices[logoIndices.length - 1] - 1
		expect(infoRow).toBeGreaterThan(logoBottom)

		// The unit (logo through info row) should be vertically centered
		const unitCenter = (logoTop + infoRow) / 2
		const contentCenter = (contentHeight - 1) / 2
		expect(Math.abs(unitCenter - contentCenter)).toBeLessThanOrEqual(1)
	})

	it("centers the logo and info line horizontally within the left column", () => {
		const theme = createMockTheme()
		const header = new LogoHeader(theme)
		const lines = header.render(120)

		// Find the info row
		const infoIndex = lines.findIndex(
			(l) => stripAnsi(l).includes("v1.0.0-test") && stripAnsi(l).includes("/project") && stripAnsi(l).includes("main"),
		)
		expect(infoIndex).toBeGreaterThan(0)

		// Strip ANSI and split by the vertical divider character
		const strippedInfo = stripAnsi(lines[infoIndex])
		const parts = strippedInfo.split("│")
		// parts[1] is the left column content area
		const leftCol = parts[1]
		expect(leftCol).toBeDefined()

		// The info text should not start at the very first position of the left column
		// (it should be centered with some leading padding)
		const infoStart = leftCol.indexOf("v1.0.0-test")
		expect(infoStart).toBeGreaterThan(1)

		// The info text should also not end at the very last position
		// (it should have trailing padding for centering)
		const infoEnd = leftCol.lastIndexOf("main") + "main".length
		expect(infoEnd).toBeLessThan(leftCol.length - 1)

		// A logo row should have the same total left column width as the info row
		const logoRow = lines.findIndex((l) => stripAnsi(l).includes("█"))
		const strippedLogo = stripAnsi(lines[logoRow])
		const logoParts = strippedLogo.split("│")
		expect(logoParts[1].length).toBe(leftCol.length)
	})
})
