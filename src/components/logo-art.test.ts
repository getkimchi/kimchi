import type { Theme } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PROMPT_VARIANT_ENV } from "../extensions/prompt-construction/variants/index.js"
import { buildInfoLines, buildLogoLines, truncatePath } from "./logo-art.js"

vi.mock("../utils.js", () => ({
	getVersion: () => "1.0.0-test",
	getFolder: () => "/project",
	getGitBranch: () => "main",
}))

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping in test assertions
const ANSI_ESCAPE = /\x1b\[[\d;]*m/g
const stripAnsi = (s: string): string => s.replace(ANSI_ESCAPE, "")

function createMockTheme(): Theme {
	const COLOR_CODE: Record<string, string> = {
		accent: "\x1b[36m",
		bashMode: "\x1b[32m",
		dim: "\x1b[2m",
		mdLink: "\x1b[35m",
	}
	return {
		getFgAnsi: vi.fn((color: string) => COLOR_CODE[color] ?? "\x1b[39m"),
	} as unknown as Theme
}

describe("truncatePath", () => {
	it("returns short paths unchanged", () => {
		expect(truncatePath("~/project", 20)).toBe("~/project")
		expect(truncatePath("/home/user/foo", 20)).toBe("/home/user/foo")
	})

	it("truncates from the right when there is no slash", () => {
		expect(truncatePath("someverylongname", 10)).toBe("somever...")
		expect(truncatePath("someverylongname", 5)).toBe("so...")
	})

	it("preserves the basename with ellipsis in the directory part", () => {
		expect(truncatePath("/home/user/cast/kimchi", 14)).toBe("/hom.../kimchi")
	})

	it("preserves the tilde prefix and basename", () => {
		expect(truncatePath("~/very/long/path/kimchi", 16)).toBe("~/very.../kimchi")
	})

	it("preserves an absolute root path prefix", () => {
		expect(truncatePath("/very/long/path/to/kimchi", 16)).toBe("/very/.../kimchi")
	})

	it("falls back to right truncation when even the minimal prefix does not fit", () => {
		expect(truncatePath("/home/user/cast/kimchi", 5)).toBe("/h...")
	})
})

describe("logo art per prompt variant", () => {
	const FIRST_GLYPH_LINE = "     █▀  █  █ ▀█▀ █▄ ▄█ ▄▀▀ █  █ ▀█▀"
	const FIRE_RED = "\x1b[38;5;196m"

	let savedVariant: string | undefined

	beforeEach(() => {
		savedVariant = process.env[PROMPT_VARIANT_ENV]
	})

	afterEach(() => {
		if (savedVariant === undefined) {
			delete process.env[PROMPT_VARIANT_ENV]
		} else {
			process.env[PROMPT_VARIANT_ENV] = savedVariant
		}
	})

	it("draws the stock logo and adds no variant line for the default variant", () => {
		delete process.env[PROMPT_VARIANT_ENV]
		const theme = createMockTheme()

		const logo = buildLogoLines(theme)
		expect(stripAnsi(logo[0])).toBe(FIRST_GLYPH_LINE)
		expect(logo[0]).not.toContain(FIRE_RED)

		const info = buildInfoLines(theme, { getBranch: () => "main" })
		expect(info.some((line) => stripAnsi(line).includes("variant"))).toBe(false)
	})

	it("draws the alternate logo and appends the tagline for a registered variant", () => {
		process.env[PROMPT_VARIANT_ENV] = "spicy"
		const theme = createMockTheme()

		const logo = buildLogoLines(theme)
		expect(stripAnsi(logo[0])).toBe(FIRST_GLYPH_LINE)
		expect(logo[0]).toContain(FIRE_RED)

		const info = buildInfoLines(theme, { getBranch: () => "main" })
		expect(stripAnsi(info[info.length - 1])).toBe("variant spicy architect")
	})

	it("falls back to the default logo and info lines for an unknown variant name", () => {
		process.env[PROMPT_VARIANT_ENV] = "no-such-variant"
		const theme = createMockTheme()

		expect(buildLogoLines(theme)[0]).not.toContain(FIRE_RED)
		const info = buildInfoLines(theme, { getBranch: () => "main" })
		expect(info.some((line) => stripAnsi(line).includes("variant"))).toBe(false)
	})
})
