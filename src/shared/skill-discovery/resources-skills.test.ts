/**
 * Every directory under resources/skills/ is a bundled skill: it must contain
 * a SKILL.md whose frontmatter passes the repo's validator (name matches the
 * folder, description present). Guards the gh-cli/glab-cli conversion from
 * behaviour bodies to bundled skills — their catalog entries (name +
 * description) are the only prompt surface they now occupy.
 */

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { validateSkill } from "./validate-skill.js"

const SKILLS_ROOT = fileURLToPath(new URL("../../../resources/skills", import.meta.url))

function skillDirs(): string[] {
	return readdirSync(SKILLS_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
}

describe("bundled resources/skills", () => {
	it("contains at least one skill", () => {
		expect(skillDirs().length).toBeGreaterThan(0)
	})

	it.each(skillDirs())("%s has a valid SKILL.md", (dir) => {
		const skillFile = join(SKILLS_ROOT, dir, "SKILL.md")
		expect(existsSync(skillFile), `${dir} is missing SKILL.md`).toBe(true)
		expect(() => validateSkill(skillFile)).not.toThrow()
	})

	it("ships the gh-cli and glab-cli skills", () => {
		const dirs = skillDirs()
		expect(dirs).toContain("gh-cli")
		expect(dirs).toContain("glab-cli")
	})
})
