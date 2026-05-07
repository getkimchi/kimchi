import { describe, expect, it } from "vitest"
import { buildCuratorPrompt, parseCuratorOutput } from "./review.js"

describe("buildCuratorPrompt", () => {
	it("includes candidate skill names in prompt", () => {
		const prompt = buildCuratorPrompt([
			{ name: "git-workflow", description: "Git branching strategy", state: "active" },
			{ name: "docker-build", description: "Build Docker images", state: "stale" },
		])
		expect(prompt).toContain("git-workflow")
		expect(prompt).toContain("docker-build")
	})

	it("includes consolidation-only instruction", () => {
		const prompt = buildCuratorPrompt([])
		expect(prompt).toContain("consolidation")
		expect(prompt).toContain("agent_created")
	})

	it("lists available tools", () => {
		const prompt = buildCuratorPrompt([])
		expect(prompt).toContain("skill_manage")
		expect(prompt).toContain("skill_view")
		expect(prompt).toContain("skill_list")
	})

	it("includes required YAML output format", () => {
		const prompt = buildCuratorPrompt([])
		expect(prompt).toContain("consolidations:")
		expect(prompt).toContain("prunings:")
	})
})

describe("parseCuratorOutput", () => {
	it("parses valid YAML summary with markdown fences", () => {
		const text = `
I've reviewed the skills.

\`\`\`yaml
consolidations:
  - from: git-branch
    into: git-workflow
    reason: Both cover Git branching
prunings:
  - name: old-docker
    reason: Superseded by docker-workflow
\`\`\`
`
		const result = parseCuratorOutput(text)
		expect(result).not.toBeNull()
		expect(result?.consolidations).toHaveLength(1)
		expect(result?.consolidations[0].from).toBe("git-branch")
		expect(result?.consolidations[0].into).toBe("git-workflow")
		expect(result?.prunings).toHaveLength(1)
		expect(result?.prunings[0].name).toBe("old-docker")
	})

	it("handles output without markdown fences", () => {
		const text = `
consolidations:
  - from: skill-a
    into: skill-b
    reason: duplicate
prunings: []
`
		const result = parseCuratorOutput(text)
		expect(result).not.toBeNull()
		expect(result?.consolidations[0].from).toBe("skill-a")
	})

	it("returns null when no YAML structure found", () => {
		const result = parseCuratorOutput("I looked at the skills. Looks good!")
		expect(result).toBeNull()
	})

	it("returns empty arrays for empty lists", () => {
		const text = "consolidations: []\nprunings: []"
		const result = parseCuratorOutput(text)
		expect(result?.consolidations).toHaveLength(0)
		expect(result?.prunings).toHaveLength(0)
	})
})
