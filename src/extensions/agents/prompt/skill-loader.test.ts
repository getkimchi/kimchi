import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { listAvailableSkillNames, preloadSkills } from "./skill-loader.js"

describe("preloadSkills", () => {
	it("returns empty array when no skill names requested", () => {
		expect(preloadSkills([], "/any/cwd")).toEqual([])
	})

	it("returns stub note for skill not found in any path", () => {
		const cwd = join(tmpdir(), `kimchi-notfound-${Date.now()}`)
		mkdirSync(cwd, { recursive: true })
		const results = preloadSkills(["nonexistent-skill"], cwd)
		expect(results).toHaveLength(1)
		expect(results[0].name).toBe("nonexistent-skill")
		expect(results[0].content).toContain("not found")
	})

	it("returns stub note for unsafe skill names", () => {
		const results = preloadSkills(["../evil"], "/any/cwd")
		expect(results).toHaveLength(1)
		expect(results[0].content).toContain("path traversal")
	})

	it("loads skill content from a real skill directory", () => {
		const base = join(tmpdir(), `kimchi-skill-test-${Date.now()}`)
		const cwd = join(base, "project")

		// Place skills at <cwd>/.pi/agent/skills (second entry in DEFAULT_SKILL_PATHS)
		const skillDir = join(cwd, ".pi", "agent", "skills", "my-skill")
		mkdirSync(skillDir, { recursive: true })
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: test\n---\nThis is the skill content.")

		const results = preloadSkills(["my-skill"], cwd)
		expect(results).toHaveLength(1)
		expect(results[0].name).toBe("my-skill")
		expect(results[0].content).toContain("This is the skill content.")
	})
})

describe("listAvailableSkillNames", () => {
	it("returns an array of skill objects with name, description, and filePath", () => {
		const base = join(tmpdir(), `kimchi-list-skills-${Date.now()}`)
		const cwd = join(base, "project")
		const skillDir = join(cwd, ".pi", "agent", "skills", "listed-skill")
		mkdirSync(skillDir, { recursive: true })
		const skillPath = join(skillDir, "SKILL.md")
		writeFileSync(skillPath, "---\nname: listed-skill\ndescription: listed\n---\nbody")

		const skills = listAvailableSkillNames(cwd)
		expect(skills).toContainEqual({
			name: "listed-skill",
			description: "listed",
			filePath: skillPath,
		})
	})

	it("resolves .config/ paths against the provided homeDir override", () => {
		const home = join(tmpdir(), `kimchi-home-skills-${Date.now()}`)
		const skillDir = join(home, ".config", "kimchi", "harness", "skills", "home-skill")
		mkdirSync(skillDir, { recursive: true })
		const skillPath = join(skillDir, "SKILL.md")
		writeFileSync(skillPath, "---\nname: home-skill\ndescription: from home\n---\nbody")

		const skills = listAvailableSkillNames("/tmp/anywhere", { homeDir: home })
		expect(skills).toContainEqual({
			name: "home-skill",
			description: "from home",
			filePath: skillPath,
		})
	})
})
