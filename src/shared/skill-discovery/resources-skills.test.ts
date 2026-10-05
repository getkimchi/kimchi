/**
 * Every directory under resources/skills/ is a bundled skill: it must contain
 * a SKILL.md whose frontmatter passes the repo's validator (name matches the
 * folder, description present). Also pins the gh-cli/glab-cli separation:
 * their guidance lives in behaviour bodies (src/extensions/behaviours/), NOT
 * in bundled skills — the skills catalog is not a second home for them.
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

	it("keeps gh/glab guidance out of the bundled skills (they are behaviours)", () => {
		const dirs = skillDirs()
		expect(dirs).not.toContain("gh-cli")
		expect(dirs).not.toContain("glab-cli")
	})
})
