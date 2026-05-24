import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let mockDir: string

vi.mock("./config.js", () => ({
	getSuperpowersVendorDir: vi.fn(() => mockDir), // updated via mockReturnValue in beforeEach
	SUPERPOWERS_VERSION: "v5.1.0",
	SUPERPOWERS_REPO: "obra/superpowers",
	SUPERPOWERS_SKILL_PATH: ".config/kimchi/vendor/superpowers/skills",
}))

import { buildSuperpowersBootstrap, resetBootstrapCache } from "./bootstrap.js"
import { getSuperpowersVendorDir } from "./config.js"

describe("buildSuperpowersBootstrap", () => {
	beforeEach(() => {
		resetBootstrapCache()
		mockDir = mkdtempSync(join(tmpdir(), "sp-bootstrap-"))
		vi.mocked(getSuperpowersVendorDir).mockReturnValue(mockDir)
		const skillDir = join(mockDir, "skills", "using-superpowers")
		mkdirSync(skillDir, { recursive: true })
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: using-superpowers\n---\n# Using Superpowers\n\nInvoke Skill tool.",
		)
	})

	afterEach(() => {
		rmSync(mockDir, { recursive: true, force: true })
		resetBootstrapCache()
		vi.restoreAllMocks()
	})

	it("returns using-superpowers body (no frontmatter) + kimchi mapping", () => {
		const result = buildSuperpowersBootstrap()
		expect(result).toContain("# Using Superpowers")
		expect(result).not.toContain("name: using-superpowers") // frontmatter stripped
		expect(result).toContain("Kimchi Platform Tool Mapping")
		expect(result).toContain("`Skill` tool")
		expect(result).toContain("`/skill:<name>`")
		expect(result).toContain("`TodoWrite`")
		expect(result).toContain("`Task` tool")
		expect(result).toContain("`Agent` tool")
	})

	it("returns empty string when vendor dir is missing", () => {
		vi.mocked(getSuperpowersVendorDir).mockReturnValue("/nonexistent/path")
		const result = buildSuperpowersBootstrap()
		expect(result).toBe("")
	})

	it("memoizes: second call with same dir does not re-read disk", () => {
		buildSuperpowersBootstrap() // prime cache
		// Delete the file after first call
		rmSync(join(mockDir, "skills", "using-superpowers", "SKILL.md"))
		// Should still return the cached result
		const result = buildSuperpowersBootstrap()
		expect(result).toContain("# Using Superpowers")
	})

	it("memoizes: second call ignores its vendorDir (first-caller-wins)", () => {
		buildSuperpowersBootstrap() // prime with mockDir (via mock)
		// Change mock to return a nonexistent dir — cache should still win
		vi.mocked(getSuperpowersVendorDir).mockReturnValue("/nonexistent")
		const result = buildSuperpowersBootstrap()
		expect(result).toContain("# Using Superpowers")
	})
})
