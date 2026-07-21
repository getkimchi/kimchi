import { describe, expect, it } from "vitest"
import { listAvailableSkillNames } from "./skill-loader.js"

describe("listAvailableSkillNames", () => {
	it("returns an array of skill objects with name and description", () => {
		const skills = listAvailableSkillNames(process.cwd())
		expect(Array.isArray(skills)).toBe(true)
		for (const skill of skills) {
			expect(typeof skill.name).toBe("string")
			expect(typeof skill.description).toBe("string")
		}
	})

	it("includes at least one skill from the project", () => {
		const skills = listAvailableSkillNames(process.cwd())
		expect(skills.length).toBeGreaterThan(0)
	})

	it("does not return duplicate names", () => {
		const skills = listAvailableSkillNames(process.cwd())
		const names = skills.map((s) => s.name)
		expect(names.length).toBe(new Set(names).size)
	})
})
