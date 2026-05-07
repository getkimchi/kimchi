import { describe, expect, it } from "vitest"
import type {
	ConsolidationProposal,
	CuratorReport,
	ExecutionResult,
	QualityIssue,
	SkillGap,
	SkillMetadata,
	TransitionProposal,
} from "./types.js"

describe("TransitionProposal", () => {
	it("has correct shape with all required fields", () => {
		const proposal: TransitionProposal = {
			checked: ["skill-a", "skill-b"],
			proposeStale: ["skill-c"],
			proposeArchive: ["skill-d"],
			proposeReactivate: ["skill-e"],
		}

		expect(proposal.checked).toBeInstanceOf(Array)
		expect(proposal.proposeStale).toBeInstanceOf(Array)
		expect(proposal.proposeArchive).toBeInstanceOf(Array)
		expect(proposal.proposeReactivate).toBeInstanceOf(Array)
		expect(proposal.checked).toHaveLength(2)
	})

	it("can represent empty proposals", () => {
		const proposal: TransitionProposal = {
			checked: [],
			proposeStale: [],
			proposeArchive: [],
			proposeReactivate: [],
		}

		expect(proposal.checked).toHaveLength(0)
	})
})

describe("SkillMetadata", () => {
	it("has correct shape for active skill", () => {
		const skill: SkillMetadata = {
			name: "test-skill",
			description: "A test skill",
			triggers: ["test", "demo"],
			category: "testing",
			state: "active",
			useCount: 42,
			lastUsedAt: "2026-01-15T10:30:00.000Z",
			agentCreated: false,
		}

		expect(skill.name).toBe("test-skill")
		expect(skill.state).toBe("active")
		expect(skill.useCount).toBe(42)
		expect(skill.agentCreated).toBe(false)
	})

	it("has correct shape for stale skill", () => {
		const skill: SkillMetadata = {
			name: "stale-skill",
			description: "An unused skill",
			triggers: [],
			category: "legacy",
			state: "stale",
			useCount: 0,
			lastUsedAt: null,
			agentCreated: true,
		}

		expect(skill.state).toBe("stale")
		expect(skill.lastUsedAt).toBeNull()
	})

	it("has correct shape for archived skill", () => {
		const skill: SkillMetadata = {
			name: "archived-skill",
			description: "An archived skill",
			triggers: ["old"],
			category: "deprecated",
			state: "archived",
			useCount: 5,
			lastUsedAt: "2025-06-01T00:00:00.000Z",
			agentCreated: false,
		}

		expect(skill.state).toBe("archived")
	})

	it("supports all three states", () => {
		const states: SkillMetadata["state"][] = ["active", "stale", "archived"]
		expect(states).toContain("active")
		expect(states).toContain("stale")
		expect(states).toContain("archived")
	})
})

describe("ConsolidationProposal", () => {
	it("has correct shape", () => {
		const proposal: ConsolidationProposal = {
			umbrella: "parent-skill",
			members: ["child-a", "child-b", "child-c"],
			rationale: "These skills share similar functionality",
		}

		expect(proposal.umbrella).toBe("parent-skill")
		expect(proposal.members).toHaveLength(3)
		expect(proposal.rationale).toBeTruthy()
	})
})

describe("SkillGap", () => {
	it("has correct shape", () => {
		const gap: SkillGap = {
			topic: "kubernetes-debugging",
			evidence: "Multiple failed kubectl commands in session logs",
			suggestedTriggers: ["debug k8s", "kubectl issue", "cluster problem"],
		}

		expect(gap.topic).toBe("kubernetes-debugging")
		expect(gap.evidence).toBeTruthy()
		expect(gap.suggestedTriggers).toBeInstanceOf(Array)
	})
})

describe("QualityIssue", () => {
	it("has correct shape for missing_description", () => {
		const issue: QualityIssue = {
			skill: "vague-skill",
			issue: "missing_description",
			suggestion: "Add a clear description explaining the skill's purpose",
		}

		expect(issue.skill).toBe("vague-skill")
		expect(issue.issue).toBe("missing_description")
	})

	it("has correct shape for missing_triggers", () => {
		const issue: QualityIssue = {
			skill: "orphan-skill",
			issue: "missing_triggers",
			suggestion: "Add trigger phrases to make this skill discoverable",
		}

		expect(issue.issue).toBe("missing_triggers")
	})

	it("has correct shape for unclear", () => {
		const issue: QualityIssue = {
			skill: "confusing-skill",
			issue: "unclear",
			suggestion: "Rewrite the description to be more specific",
		}

		expect(issue.issue).toBe("unclear")
	})

	it("supports all issue types", () => {
		const issueTypes: QualityIssue["issue"][] = ["missing_description", "missing_triggers", "unclear"]
		expect(issueTypes).toHaveLength(3)
	})
})

describe("CuratorReport", () => {
	it("has correct shape with all fields", () => {
		const report: CuratorReport = {
			autoTransitions: {
				checked: ["skill-a"],
				proposeStale: [],
				proposeArchive: ["skill-b"],
				proposeReactivate: [],
			},
			consolidationProposals: [
				{
					umbrella: "unified-skill",
					members: ["old-a", "old-b"],
					rationale: "Redundant functionality",
				},
			],
			skillGaps: [
				{
					topic: "test-gap",
					evidence: "Evidence here",
					suggestedTriggers: ["test trigger"],
				},
			],
			qualityIssues: [
				{
					skill: "bad-skill",
					issue: "missing_description",
					suggestion: "Add description",
				},
			],
		}

		expect(report.autoTransitions).toBeDefined()
		expect(report.consolidationProposals).toBeInstanceOf(Array)
		expect(report.skillGaps).toBeInstanceOf(Array)
		expect(report.qualityIssues).toBeInstanceOf(Array)
	})

	it("can represent empty report", () => {
		const report: CuratorReport = {
			autoTransitions: {
				checked: [],
				proposeStale: [],
				proposeArchive: [],
				proposeReactivate: [],
			},
			consolidationProposals: [],
			skillGaps: [],
			qualityIssues: [],
		}

		expect(report.consolidationProposals).toHaveLength(0)
		expect(report.skillGaps).toHaveLength(0)
		expect(report.qualityIssues).toHaveLength(0)
	})
})

describe("ExecutionResult", () => {
	it("has correct shape for successful execution", () => {
		const result: ExecutionResult = {
			phaseA: { success: true },
			phaseB: {
				succeeded: ["skill-a", "skill-b"],
				failed: [],
			},
		}

		expect(result.phaseA.success).toBe(true)
		expect(result.phaseA.error).toBeUndefined()
		expect(result.phaseB.succeeded).toHaveLength(2)
		expect(result.phaseB.failed).toHaveLength(0)
	})

	it("has correct shape for failed phaseA", () => {
		const result: ExecutionResult = {
			phaseA: { success: false, error: "Permission denied" },
			phaseB: {
				succeeded: [],
				failed: [],
			},
		}

		expect(result.phaseA.success).toBe(false)
		expect(result.phaseA.error).toBe("Permission denied")
	})

	it("has correct shape for partial phaseB failures", () => {
		const result: ExecutionResult = {
			phaseA: { success: true },
			phaseB: {
				succeeded: ["skill-a"],
				failed: [{ proposal: "skill-b", error: "Archive failed" }],
			},
		}

		expect(result.phaseB.succeeded).toHaveLength(1)
		expect(result.phaseB.failed).toHaveLength(1)
		expect(result.phaseB.failed[0].proposal).toBe("skill-b")
		expect(result.phaseB.failed[0].error).toBe("Archive failed")
	})
})
