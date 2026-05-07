import { describe, expect, it } from "vitest"
import { buildReviewPrompt, parseLLMResponse } from "./review-agent.js"
import type { LogSummary, SkillMetadata, TransitionProposal } from "./types.js"

describe("buildReviewPrompt", () => {
	const mockSkills: SkillMetadata[] = [
		{
			name: "test-skill",
			description: "A test skill",
			triggers: ["test", "run"],
			category: "testing",
			state: "active",
			useCount: 5,
			lastUsedAt: "2024-01-01",
			agentCreated: true,
		},
		{
			name: "debug-skill",
			description: "A debugging skill",
			triggers: [],
			category: "debugging",
			state: "active",
			useCount: 3,
			lastUsedAt: "2024-01-02",
			agentCreated: true,
		},
	]

	const mockProposal: TransitionProposal = {
		checked: ["test-skill", "debug-skill"],
		proposeStale: [],
		proposeArchive: [],
		proposeReactivate: [],
	}

	const mockLogs: LogSummary = {
		summaries: ["Session 1 summary", "Session 2 summary"],
		failurePatterns: [{ type: "TypeError", count: 3, lastSeen: "2024-01-01" }],
	}

	it("includes skill inventory", () => {
		const prompt = buildReviewPrompt(mockSkills, mockProposal, mockLogs)
		expect(prompt).toContain("test-skill: A test skill")
		expect(prompt).toContain("debug-skill: A debugging skill")
		expect(prompt).toContain("agent-created skills")
	})

	it("includes auto-transition counts", () => {
		const prompt = buildReviewPrompt(mockSkills, mockProposal, mockLogs)
		expect(prompt).toContain("checked: 2 skills")
		expect(prompt).toContain("proposeStale: 0 skills")
		expect(prompt).toContain("proposeArchive: 0 skills")
		expect(prompt).toContain("proposeReactivate: 0 skills")
	})

	it("includes recent session summaries", () => {
		const prompt = buildReviewPrompt(mockSkills, mockProposal, mockLogs)
		expect(prompt).toContain("Session 1 summary")
		expect(prompt).toContain("Session 2 summary")
	})

	it("includes failure patterns", () => {
		const prompt = buildReviewPrompt(mockSkills, mockProposal, mockLogs)
		expect(prompt).toContain("TypeError")
		expect(prompt).toContain("3 occurrences")
	})

	it("handles empty skills gracefully", () => {
		const prompt = buildReviewPrompt([], mockProposal, mockLogs)
		expect(prompt).toContain("0 agent-created skills")
		expect(prompt).toContain("(no skills)")
	})

	it("handles empty logs gracefully", () => {
		const emptyLogs: LogSummary = { summaries: [], failurePatterns: [] }
		const prompt = buildReviewPrompt(mockSkills, mockProposal, emptyLogs)
		expect(prompt).toContain("(no recent sessions)")
		expect(prompt).toContain("(no failures logged)")
	})
})

describe("parseLLMResponse", () => {
	it("extracts consolidation_proposals from YAML", () => {
		const response = `\`\`\`yaml
consolidation_proposals:
  - umbrella: debugging
    members: [debug-skill, debug-verbose]
    rationale: Both handle debugging scenarios
\`\`\``

		const result = parseLLMResponse(response)
		expect(result.consolidationProposals).toHaveLength(1)
		expect(result.consolidationProposals[0]).toEqual({
			umbrella: "debugging",
			members: ["debug-skill", "debug-verbose"],
			rationale: "Both handle debugging scenarios",
		})
	})

	it("extracts skill_gaps from YAML", () => {
		const response = `\`\`\`yaml
skill_gaps:
  - topic: kubernetes
    evidence: Multiple session failures related to kubectl
    suggested_triggers: [k8s, kubernetes, kubectl]
\`\`\``

		const result = parseLLMResponse(response)
		expect(result.skillGaps).toHaveLength(1)
		expect(result.skillGaps[0]).toEqual({
			topic: "kubernetes",
			evidence: "Multiple session failures related to kubectl",
			suggestedTriggers: ["k8s", "kubernetes", "kubectl"],
		})
	})

	it("extracts quality_issues from YAML", () => {
		const response = `\`\`\`yaml
quality_issues:
  - skill: debug-skill
    issue: missing_triggers
    suggestion: Add triggers like "debug", "fix", "troubleshoot"
\`\`\``

		const result = parseLLMResponse(response)
		expect(result.qualityIssues).toHaveLength(1)
		expect(result.qualityIssues[0]).toEqual({
			skill: "debug-skill",
			issue: "missing_triggers",
			suggestion: 'Add triggers like "debug", "fix", "troubleshoot"',
		})
	})

	it("handles malformed YAML gracefully", () => {
		const result = parseLLMResponse("not yaml at all")
		expect(result).toEqual({
			consolidationProposals: [],
			skillGaps: [],
			qualityIssues: [],
		})
	})

	it("handles empty YAML block gracefully", () => {
		const result = parseLLMResponse("```yaml\n```")
		expect(result).toEqual({
			consolidationProposals: [],
			skillGaps: [],
			qualityIssues: [],
		})
	})

	it("handles response without code fences", () => {
		const response = `consolidation_proposals:
  - umbrella: testing
    members: [test-skill]
    rationale: Related testing skills`

		const result = parseLLMResponse(response)
		expect(result.consolidationProposals).toHaveLength(1)
		expect(result.consolidationProposals[0].umbrella).toBe("testing")
	})

	it("extracts all three sections together", () => {
		const response = `\`\`\`yaml
consolidation_proposals:
  - umbrella: db
    members: [mysql, postgres]
    rationale: Database skills
skill_gaps:
  - topic: caching
    evidence: No redis mentions
    suggested_triggers: [redis, cache]
quality_issues:
  - skill: old-skill
    issue: missing_description
    suggestion: Add a description
\`\`\``

		const result = parseLLMResponse(response)
		expect(result.consolidationProposals).toHaveLength(1)
		expect(result.skillGaps).toHaveLength(1)
		expect(result.qualityIssues).toHaveLength(1)
	})
})
