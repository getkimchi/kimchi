import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildSuperpowersBootstrap, resetBootstrapCache } from "./bootstrap.js"

describe("buildSuperpowersBootstrap", () => {
	let mockDir: string

	beforeEach(() => {
		resetBootstrapCache()
		mockDir = mkdtempSync(join(tmpdir(), "sp-bootstrap-"))
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
	})

	it("returns using-superpowers body (no frontmatter) + kimchi mapping", () => {
		const result = buildSuperpowersBootstrap(mockDir)
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
		const result = buildSuperpowersBootstrap("/nonexistent/path")
		expect(result).toBe("")
	})

	it("memoizes: second call with same dir does not re-read disk", () => {
		buildSuperpowersBootstrap(mockDir) // prime cache
		// Delete the file after first call
		rmSync(join(mockDir, "skills", "using-superpowers", "SKILL.md"))
		// Should still return the cached result
		const result = buildSuperpowersBootstrap(mockDir)
		expect(result).toContain("# Using Superpowers")
	})
})
