import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getKimchiProjectSkillPaths } from "./skill-paths.js"

let dir: string

describe("project skill paths", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-project-skills-"))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it("discovers nearest ancestor Kimchi project skill directory", () => {
		const projectSkills = join(dir, "project", ".kimchi", "skills")
		writeSkill(join(projectSkills, "typescript-safety", "SKILL.md"))

		expect(getKimchiProjectSkillPaths(join(dir, "project", "src", "feature"))).toEqual([projectSkills])
	})

	it("does not return missing Kimchi project skill directories", () => {
		expect(getKimchiProjectSkillPaths(join(dir, "project", "src"))).toEqual([])
	})
})

function writeSkill(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, "---\ndescription: Test skill.\n---\n# Skill\n", "utf-8")
}
