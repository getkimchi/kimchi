import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "./project-scope-trust.js"
import { getKimchiProjectSkillPaths } from "./skill-paths.js"

let dir: string

describe("project skill paths", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-project-skills-"))
		resetProjectScopeTrustForTests()
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it("discovers nearest ancestor Kimchi project skill directory", () => {
		const projectSkills = join(dir, "project", ".kimchi", "skills")
		writeSkill(join(projectSkills, "typescript-safety", "SKILL.md"))

		setProjectScopeTrusted(join(dir, "project"), true)
		expect(getKimchiProjectSkillPaths(join(dir, "project", "src", "feature"))).toEqual([projectSkills])
	})

	it("does not return missing Kimchi project skill directories", () => {
		setProjectScopeTrusted(join(dir, "project"), true)
		expect(getKimchiProjectSkillPaths(join(dir, "project", "src"))).toEqual([])
	})

	it("returns no project skill directory while the project is untrusted (fail closed)", () => {
		const projectSkills = join(dir, "project", ".kimchi", "skills")
		writeSkill(join(projectSkills, "injected-instructions", "SKILL.md"))

		// No setProjectScopeTrusted call: a cloned repo's skills stay inert.
		expect(getKimchiProjectSkillPaths(join(dir, "project", "src", "feature"))).toEqual([])
	})
})

function writeSkill(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, "---\ndescription: Test skill.\n---\n# Skill\n", "utf-8")
}
