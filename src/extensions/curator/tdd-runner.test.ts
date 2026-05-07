import { afterEach, describe, expect, it, vi } from "vitest"
import { spawnSubagent } from "../subagent.js"
import { runREDBaseline, runREFACTORVerify } from "./tdd-runner.js"

vi.mock("../subagent.js", () => ({
	spawnSubagent: vi.fn(),
}))

const mockSpawnSubagent = vi.mocked(spawnSubagent)

describe("tdd-runner", () => {
	afterEach(() => {
		vi.clearAllMocks()
	})

	describe("runREDBaseline", () => {
		it("excludes only the memberSkills being consolidated", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("I completed the task using my own knowledge.")

			await runREDBaseline({
				task: "Implement feature X",
				memberSkills: ["skill-a", "skill-b"],
				skillsDir: "/skills",
			})

			expect(mockSpawnSubagent).toHaveBeenCalledTimes(1)
			const call = mockSpawnSubagent.mock.calls[0][0]
			// Should exclude only the member skills
			expect(call.prompt).toContain("Do NOT use these skills: skill-a, skill-b")
			// Should NOT exclude other skills (skills not in memberSkills)
			expect(call.prompt).not.toContain("some-other-skill")
		})

		it("does not add exclusion when memberSkills is empty", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("Task completed.")

			await runREDBaseline({
				task: "Implement feature X",
				memberSkills: [],
				skillsDir: "/skills",
			})

			expect(mockSpawnSubagent).toHaveBeenCalledTimes(1)
			const call = mockSpawnSubagent.mock.calls[0][0]
			expect(call.prompt).not.toContain("Do NOT use")
		})

		it("identifies gaps when agent reports missing skill guidance", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("I couldn't find the skill for this task. I had to guess.")

			const result = await runREDBaseline({
				task: "Implement feature X",
				memberSkills: ["skill-a"],
				skillsDir: "/skills",
			})

			expect(result.gapsIdentified).toContain("Agent could not find needed skill guidance")
			expect(result.gapsIdentified).toContain("Agent fell back to trial-and-error")
		})

		it("reports skills needed from memberSkills", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("Task completed.")

			const result = await runREDBaseline({
				task: "Implement feature X",
				memberSkills: ["skill-a", "skill-b", "skill-c"],
				skillsDir: "/skills",
			})

			expect(result.skillsNeeded).toEqual(["skill-a", "skill-b", "skill-c"])
		})

		it("extracts skills used from output", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("I used skill: filesystem to read the file and skill: git to commit.")

			const result = await runREDBaseline({
				task: "Implement feature X",
				memberSkills: ["skill-a"],
				skillsDir: "/skills",
			})

			expect(result.skillsUsed).toContain("filesystem")
			expect(result.skillsUsed).toContain("git")
		})

		it("deduplicates extracted skills", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("Used skill: testing and skill: testing again for testing.")

			const result = await runREDBaseline({
				task: "Implement feature X",
				memberSkills: ["skill-a"],
				skillsDir: "/skills",
			})

			expect(result.skillsUsed).toEqual(["testing"])
		})
	})

	describe("runREFACTORVerify", () => {
		it("detects umbrella skill usage in output", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("I used the my-umbrella-skill and found the guidance I needed.")

			const result = await runREFACTORVerify({
				task: "Implement feature X",
				umbrellaName: "my-umbrella-skill",
				skillsDir: "/skills",
			})

			expect(result.umbrellaUsed).toBe(true)
		})

		it("detects umbrella skill with case insensitivity", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("I used the MY-UMBRELLA-SKILL for this task.")

			const result = await runREFACTORVerify({
				task: "Implement feature X",
				umbrellaName: "my-umbrella-skill",
				skillsDir: "/skills",
			})

			expect(result.umbrellaUsed).toBe(true)
		})

		it("reports umbrellaUsed false when skill not mentioned", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("I completed the task using general knowledge.")

			const result = await runREFACTORVerify({
				task: "Implement feature X",
				umbrellaName: "my-umbrella-skill",
				skillsDir: "/skills",
			})

			expect(result.umbrellaUsed).toBe(false)
		})

		it("extracts behaviors from output", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("I found the skill and used it to complete the task.")

			const result = await runREFACTORVerify({
				task: "Implement feature X",
				umbrellaName: "my-umbrella-skill",
				skillsDir: "/skills",
			})

			expect(result.behaviors).toContain("used_skill")
			expect(result.behaviors).toContain("found_guidance")
		})

		it("extracts attempted_directly behavior", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("I tried to complete the task directly without the skill.")

			const result = await runREFACTORVerify({
				task: "Implement feature X",
				umbrellaName: "my-umbrella-skill",
				skillsDir: "/skills",
			})

			expect(result.behaviors).toContain("attempted_directly")
		})
	})

	describe("extractSkillsUsed", () => {
		it("handles various skill patterns", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("skill: testing, skill:deployment, skill: monitoring")

			const result = await runREDBaseline({
				task: "Test",
				memberSkills: [],
				skillsDir: "/skills",
			})

			expect(result.skillsUsed).toContain("testing")
			expect(result.skillsUsed).toContain("deployment")
			expect(result.skillsUsed).toContain("monitoring")
		})

		it("returns empty array when no skills found", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("No skills mentioned in this output.")

			const result = await runREDBaseline({
				task: "Test",
				memberSkills: [],
				skillsDir: "/skills",
			})

			expect(result.skillsUsed).toEqual([])
		})
	})
})
