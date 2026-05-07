import { describe, expect, it } from "vitest"
import type {
	AuditDigest,
	ConsolidationProposal,
	ConsolidationRecord,
	ConsolidationStrategy,
	CuratorReport,
	RollbackRecord,
	SubagentBaselineResult,
	SubagentVerifyResult,
	TDDPhase,
	TransitionRecord,
} from "./types.js"

describe("TDD and Audit types", () => {
	describe("ConsolidationStrategy", () => {
		it("should accept merge_into_existing", () => {
			const strategy: ConsolidationStrategy = "merge_into_existing"
			expect(strategy).toBe("merge_into_existing")
		})

		it("should accept create_new", () => {
			const strategy: ConsolidationStrategy = "create_new"
			expect(strategy).toBe("create_new")
		})

		it("should accept demote_to_references", () => {
			const strategy: ConsolidationStrategy = "demote_to_references"
			expect(strategy).toBe("demote_to_references")
		})
	})

	describe("ConsolidationProposal", () => {
		it("should require strategy field", () => {
			const proposal: ConsolidationProposal = {
				umbrella: "test-umbrella",
				members: ["skill-a", "skill-b"],
				rationale: "These skills overlap in functionality",
				strategy: "merge_into_existing",
			}
			expect(proposal.strategy).toBe("merge_into_existing")
		})
	})

	describe("AuditDigest", () => {
		it("should hold consolidation audit data", () => {
			const digest: AuditDigest = {
				timestamp: "2026-05-07T10:00:00Z",
				skillCountBefore: 10,
				skillCountAfter: 8,
				consolidations: [
					{
						umbrella: "test-umbrella",
						members: ["skill-a", "skill-b"],
						strategy: "merge_into_existing",
						rationale: "Merged overlapping skills",
						referencesCreated: [],
					},
				],
				autoTransitionsApplied: [],
				rollbacks: [],
			}
			expect(digest.skillCountBefore).toBe(10)
			expect(digest.skillCountAfter).toBe(8)
			expect(digest.consolidations).toHaveLength(1)
		})
	})

	describe("ConsolidationRecord", () => {
		it("should use members array (not absorbed)", () => {
			const record: ConsolidationRecord = {
				umbrella: "my-umbrella",
				members: ["skill-1", "skill-2"],
				strategy: "create_new",
				rationale: "Creating new unified skill",
				referencesCreated: ["ref-1"],
			}
			expect(record.members).toEqual(["skill-1", "skill-2"])
			expect(record.referencesCreated).toEqual(["ref-1"])
		})
	})

	describe("TransitionRecord", () => {
		it("should track state transitions", () => {
			const record: TransitionRecord = {
				name: "my-skill",
				from: "active",
				to: "stale",
			}
			expect(record.from).toBe("active")
			expect(record.to).toBe("stale")
		})
	})

	describe("RollbackRecord", () => {
		it("should track rollback events", () => {
			const record: RollbackRecord = {
				timestamp: "2026-05-07T12:00:00Z",
				backupDir: "/backups/snapshot-2026-05-07",
				reason: "Consolidation produced errors",
			}
			expect(record.backupDir).toBe("/backups/snapshot-2026-05-07")
		})
	})

	describe("TDDPhase", () => {
		it("should accept RED phase", () => {
			const phase: TDDPhase = "RED"
			expect(phase).toBe("RED")
		})

		it("should accept GREEN phase", () => {
			const phase: TDDPhase = "GREEN"
			expect(phase).toBe("GREEN")
		})

		it("should accept REFACTOR phase", () => {
			const phase: TDDPhase = "REFACTOR"
			expect(phase).toBe("REFACTOR")
		})
	})

	describe("SubagentBaselineResult", () => {
		it("should capture RED phase baseline", () => {
			const result: SubagentBaselineResult = {
				phase: "RED",
				prompt: "Implement feature X",
				output: "Attempted but failed...",
				skillsUsed: ["implement-skill"],
				skillsNeeded: ["test-skill", "refactor-skill"],
				gapsIdentified: ["No tests exist", "Implementation incomplete"],
			}
			expect(result.phase).toBe("RED")
			expect(result.gapsIdentified).toHaveLength(2)
		})
	})

	describe("SubagentVerifyResult", () => {
		it("should capture REFACTOR phase verification", () => {
			const result: SubagentVerifyResult = {
				phase: "REFACTOR",
				prompt: "Verify the refactored implementation",
				output: "All checks passed...",
				umbrellaUsed: true,
				behaviors: ["uses consolidation pattern", "proper error handling"],
			}
			expect(result.phase).toBe("REFACTOR")
			expect(result.umbrellaUsed).toBe(true)
		})
	})

	describe("CuratorReport", () => {
		it("should include optional audit field", () => {
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
				audit: {
					timestamp: "2026-05-07T09:00:00Z",
					skillCountBefore: 5,
					skillCountAfter: 4,
					consolidations: [],
					autoTransitionsApplied: [],
					rollbacks: [],
				},
			}
			expect(report.audit).toBeDefined()
			expect(report.audit?.skillCountBefore).toBe(5)
		})

		it("should work without audit field", () => {
			const report: CuratorReport = {
				autoTransitions: {
					checked: ["skill-1"],
					proposeStale: [],
					proposeArchive: [],
					proposeReactivate: [],
				},
				consolidationProposals: [],
				skillGaps: [],
				qualityIssues: [],
			}
			expect(report.audit).toBeUndefined()
		})
	})
})
