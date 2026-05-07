import { beforeEach, describe, expect, it, vi } from "vitest"
import { executeReport } from "./executor.js"
import type { ConsolidationProposal, CuratorReport } from "./types.js"

// Mock the backup module
vi.mock("./backup.js", async () => {
	const actual = await vi.importActual("./backup.js")
	return {
		...actual,
		snapshotBeforeCurator: vi.fn(),
		rollback: vi.fn(),
	}
})

// Mock the helpers module
vi.mock("./helpers.js", async () => {
	const actual = await vi.importActual("./helpers.js")
	return {
		...actual,
		readMemberContents: vi.fn(),
		synthesizeUmbrellaContent: vi.fn(),
		readSkillContent: vi.fn(),
	}
})

// Mock usage module
vi.mock("../skills-manager/usage.js", async () => {
	const actual = await vi.importActual("../skills-manager/usage.js")
	return {
		...actual,
		setStateBatch: vi.fn(),
		UsageTracker: vi.fn().mockImplementation(() => ({
			archive: vi.fn(),
		})),
	}
})

// Mock skill-manager module
vi.mock("../skills-manager/skill-manager.js", async () => {
	const actual = await vi.importActual("../skills-manager/skill-manager.js")
	return {
		...actual,
		archiveSkill: vi.fn(),
		SkillManager: vi.fn().mockImplementation(() => ({
			exists: vi.fn(),
			create: vi.fn(),
			delete: vi.fn(),
			patch: vi.fn(),
			writeFile: vi.fn(),
		})),
	}
})

import { SkillManager, archiveSkill } from "../skills-manager/skill-manager.js"
import { UsageTracker, setStateBatch } from "../skills-manager/usage.js"
import { rollback, snapshotBeforeCurator } from "./backup.js"
import { readMemberContents, readSkillContent, synthesizeUmbrellaContent } from "./helpers.js"

const mockSnapshotBeforeCurator = snapshotBeforeCurator as ReturnType<typeof vi.fn>
const mockRollback = rollback as ReturnType<typeof vi.fn>
const mockReadMemberContents = readMemberContents as ReturnType<typeof vi.fn>
const mockSynthesizeUmbrellaContent = synthesizeUmbrellaContent as ReturnType<typeof vi.fn>
const mockReadSkillContent = readSkillContent as ReturnType<typeof vi.fn>
const mockSetStateBatch = setStateBatch as ReturnType<typeof vi.fn>
const mockUsageTrackerArchive = UsageTracker as unknown as { prototype: { archive: ReturnType<typeof vi.fn> } }
const mockArchiveSkill = archiveSkill as ReturnType<typeof vi.fn>

// Create a mock SkillManager instance
const mockManager = {
	exists: vi.fn(),
	create: vi.fn(),
	delete: vi.fn(),
	patch: vi.fn(),
	writeFile: vi.fn(),
}

const mockTracker = {
	archive: vi.fn(),
}

const createSkillManagerMock = () => mockManager
const createUsageTrackerMock = () => mockTracker

// Patch the mock constructors to return our mock instances
vi.mocked(SkillManager).mockImplementation(() => mockManager as unknown as InstanceType<typeof SkillManager>)
vi.mocked(UsageTracker).mockImplementation(() => mockTracker as unknown as InstanceType<typeof UsageTracker>)

const SKILLS_DIR = "/test/skills"

describe("executeReport", () => {
	beforeEach(() => {
		vi.clearAllMocks()

		// Default: backup succeeds
		mockSnapshotBeforeCurator.mockResolvedValue("/test/backups/2024-01-01")
		mockRollback.mockResolvedValue(undefined)

		// Default: all skills exist
		mockManager.exists.mockResolvedValue(true)
		mockManager.exists.mockImplementation(async (name: string) => !name.includes("missing") && !name.includes("broken"))

		// Default: successful skill operations
		mockManager.create.mockResolvedValue({ success: true })
		mockManager.delete.mockResolvedValue({ success: true })
		mockManager.patch.mockResolvedValue({ success: true })
		mockManager.writeFile.mockResolvedValue({ success: true })

		// Default: successful state changes
		mockSetStateBatch.mockResolvedValue(undefined)
		mockArchiveSkill.mockResolvedValue(true)

		// Default: successful helpers
		mockReadMemberContents.mockResolvedValue({})
		mockSynthesizeUmbrellaContent.mockResolvedValue("---\nname: umbrella\n---\nUmbrella content")
		mockReadSkillContent.mockResolvedValue("# Skill content")

		// Default: tracker
		mockTracker.archive.mockResolvedValue({} as never)
	})

	describe("initialBackupDir parameter", () => {
		it("uses provided initialBackupDir and skips snapshot creation", async () => {
			const initialBackupDir = "/custom/backup/path"
			const report: CuratorReport = {
				autoTransitions: { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] },
				consolidationProposals: [],
				skillGaps: [],
				qualityIssues: [],
			}

			await executeReport(report, SKILLS_DIR, initialBackupDir)

			// snapshotBeforeCurator should NOT have been called
			expect(mockSnapshotBeforeCurator).not.toHaveBeenCalled()
			// But rollback should still be set up correctly
			expect(mockRollback).not.toHaveBeenCalled() // No failures, so no rollback
		})

		it("creates snapshot when initialBackupDir is not provided", async () => {
			const report: CuratorReport = {
				autoTransitions: { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] },
				consolidationProposals: [],
				skillGaps: [],
				qualityIssues: [],
			}

			await executeReport(report, SKILLS_DIR)

			expect(mockSnapshotBeforeCurator).toHaveBeenCalledWith(SKILLS_DIR)
		})

		it("continues without backup if snapshot fails", async () => {
			mockSnapshotBeforeCurator.mockRejectedValue(new Error("Backup failed"))

			const report: CuratorReport = {
				autoTransitions: { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] },
				consolidationProposals: [],
				skillGaps: [],
				qualityIssues: [],
			}

			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			await executeReport(report, SKILLS_DIR)

			// Should continue without throwing
			expect(mockSnapshotBeforeCurator).toHaveBeenCalled()
			expect(mockRollback).not.toHaveBeenCalled() // No failures, so no rollback

			consoleSpy.mockRestore()
		})
	})

	describe("Phase A operations", () => {
		it("executes reactivate transitions", async () => {
			const report: CuratorReport = {
				autoTransitions: {
					checked: [],
					proposeStale: [],
					proposeArchive: [],
					proposeReactivate: ["skill-a", "skill-b"],
				},
				consolidationProposals: [],
				skillGaps: [],
				qualityIssues: [],
			}

			await executeReport(report, SKILLS_DIR)

			expect(mockSetStateBatch).toHaveBeenCalledWith([
				{ name: "skill-a", state: "active" },
				{ name: "skill-b", state: "active" },
			])
		})

		it("executes stale transitions", async () => {
			const report: CuratorReport = {
				autoTransitions: {
					checked: [],
					proposeStale: ["skill-x", "skill-y"],
					proposeArchive: [],
					proposeReactivate: [],
				},
				consolidationProposals: [],
				skillGaps: [],
				qualityIssues: [],
			}

			await executeReport(report, SKILLS_DIR)

			expect(mockSetStateBatch).toHaveBeenCalledWith([
				{ name: "skill-x", state: "stale" },
				{ name: "skill-y", state: "stale" },
			])
		})

		it("archives skills", async () => {
			const report: CuratorReport = {
				autoTransitions: {
					checked: [],
					proposeStale: [],
					proposeArchive: ["dead-skill"],
					proposeReactivate: [],
				},
				consolidationProposals: [],
				skillGaps: [],
				qualityIssues: [],
			}

			await executeReport(report, SKILLS_DIR)

			expect(mockArchiveSkill).toHaveBeenCalledWith("dead-skill")
		})

		it("throws on Phase A failure (fail-fast)", async () => {
			mockSetStateBatch.mockRejectedValue(new Error("Disk full"))

			const report: CuratorReport = {
				autoTransitions: {
					checked: [],
					proposeStale: ["skill-x"],
					proposeArchive: [],
					proposeReactivate: [],
				},
				consolidationProposals: [],
				skillGaps: [],
				qualityIssues: [],
			}

			await expect(executeReport(report, SKILLS_DIR)).rejects.toThrow("Disk full")
			expect(mockArchiveSkill).not.toHaveBeenCalled()
		})
	})

	describe("Phase B consolidation strategies", () => {
		it("executes create_new strategy", async () => {
			const proposal: ConsolidationProposal = {
				umbrella: "new-umbrella",
				members: ["member-1", "member-2"],
				rationale: "Create new skill",
				strategy: "create_new",
			}

			const report: CuratorReport = {
				autoTransitions: { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] },
				consolidationProposals: [proposal],
				skillGaps: [],
				qualityIssues: [],
			}

			const result = await executeReport(report, SKILLS_DIR)

			expect(result.phaseB.succeeded).toContain("new-umbrella")
			expect(result.phaseB.failed).toHaveLength(0)
			expect(mockManager.create).toHaveBeenCalledWith("new-umbrella", expect.stringContaining("Umbrella content"))
			expect(mockManager.delete).toHaveBeenCalledTimes(2) // Two members archived
			expect(mockTracker.archive).toHaveBeenCalledTimes(2)
		})

		it("executes merge_into_existing strategy", async () => {
			const proposal: ConsolidationProposal = {
				umbrella: "existing-umbrella",
				members: ["member-1", "member-2"],
				rationale: "Merge into existing",
				strategy: "merge_into_existing",
			}

			const report: CuratorReport = {
				autoTransitions: { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] },
				consolidationProposals: [proposal],
				skillGaps: [],
				qualityIssues: [],
			}

			const result = await executeReport(report, SKILLS_DIR)

			expect(result.phaseB.succeeded).toContain("existing-umbrella")
			// First member should NOT be deleted (stays in place)
			expect(mockManager.delete).toHaveBeenCalledTimes(1) // Only second member deleted
			expect(mockManager.patch).toHaveBeenCalledWith("existing-umbrella", "<!-- NEW SECTION -->", expect.any(String))
		})

		it("executes demote_to_references strategy", async () => {
			const proposal: ConsolidationProposal = {
				umbrella: "reference-umbrella",
				members: ["member-1", "member-2"],
				rationale: "Demote to references",
				strategy: "demote_to_references",
			}

			const report: CuratorReport = {
				autoTransitions: { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] },
				consolidationProposals: [proposal],
				skillGaps: [],
				qualityIssues: [],
			}

			const result = await executeReport(report, SKILLS_DIR)

			expect(result.phaseB.succeeded).toContain("reference-umbrella")
			expect(mockManager.writeFile).toHaveBeenCalledWith(
				"reference-umbrella",
				expect.stringContaining("references/"),
				expect.any(String),
			)
			expect(mockManager.delete).toHaveBeenCalledTimes(2)
		})

		it("creates umbrella for demote strategy if it doesn't exist", async () => {
			mockManager.exists.mockImplementation(async (name: string) => {
				// Umbrella doesn't exist, members do exist
				return name !== "reference-umbrella"
			})

			const proposal: ConsolidationProposal = {
				umbrella: "reference-umbrella",
				members: ["member-1"],
				rationale: "Demote to references",
				strategy: "demote_to_references",
			}

			const report: CuratorReport = {
				autoTransitions: { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] },
				consolidationProposals: [proposal],
				skillGaps: [],
				qualityIssues: [],
			}

			const result = await executeReport(report, SKILLS_DIR)

			expect(result.phaseB.succeeded).toContain("reference-umbrella")
			expect(mockManager.create).toHaveBeenCalled()
		})
	})

	describe("Phase B rollback on failure", () => {
		it("triggers rollback when consolidation fails", async () => {
			mockManager.create.mockResolvedValue({ success: false, error: "Creation failed" })

			const report: CuratorReport = {
				autoTransitions: { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] },
				consolidationProposals: [
					{
						umbrella: "broken-skill",
						members: ["member-a"],
						rationale: "Will fail",
						strategy: "create_new",
					},
				],
				skillGaps: [],
				qualityIssues: [],
			}

			const result = await executeReport(report, SKILLS_DIR)

			expect(result.phaseB.failed).toHaveLength(1)
			expect(result.phaseB.failed[0].proposal).toBe("broken-skill")
			expect(mockRollback).toHaveBeenCalled()
		})

		it("does not rollback when there is no backupDir", async () => {
			mockSnapshotBeforeCurator.mockRejectedValue(new Error("Backup failed"))
			// Make consolidation fail so we can verify no rollback occurs
			mockManager.create.mockResolvedValue({ success: false, error: "Creation failed" })

			const report: CuratorReport = {
				autoTransitions: { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] },
				consolidationProposals: [
					{
						umbrella: "broken-skill",
						members: ["member-a"],
						rationale: "Will fail",
						strategy: "create_new",
					},
				],
				skillGaps: [],
				qualityIssues: [],
			}

			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			const result = await executeReport(report, SKILLS_DIR)

			expect(result.phaseB.failed).toHaveLength(1)
			expect(mockRollback).not.toHaveBeenCalled() // No rollback without backup

			consoleErrorSpy.mockRestore()
		})

		it("continues to next consolidation if rollback fails", async () => {
			mockManager.create.mockImplementation(async (name: string) => {
				if (name.includes("broken")) {
					return { success: false, error: "Creation failed" }
				}
				return { success: true }
			})
			mockRollback.mockRejectedValue(new Error("Rollback failed"))

			const report: CuratorReport = {
				autoTransitions: { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] },
				consolidationProposals: [
					{
						umbrella: "broken-skill",
						members: ["member-a"],
						rationale: "Will fail",
						strategy: "create_new",
					},
					{
						umbrella: "good-skill",
						members: ["member-b"],
						rationale: "Will succeed",
						strategy: "create_new",
					},
				],
				skillGaps: [],
				qualityIssues: [],
			}

			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			const result = await executeReport(report, SKILLS_DIR)

			expect(result.phaseB.failed).toHaveLength(1)
			expect(result.phaseB.failed[0].proposal).toBe("broken-skill")
			expect(result.phaseB.succeeded).toContain("good-skill")

			consoleErrorSpy.mockRestore()
		})
	})

	describe("Phase B member validation", () => {
		it("fails consolidation if member not found", async () => {
			mockManager.exists.mockImplementation(async (name: string) => name !== "missing-skill")

			const report: CuratorReport = {
				autoTransitions: { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] },
				consolidationProposals: [
					{
						umbrella: "unified-skill",
						members: ["skill-1", "missing-skill"],
						rationale: "Combine skills",
						strategy: "create_new",
					},
				],
				skillGaps: [],
				qualityIssues: [],
			}

			const result = await executeReport(report, SKILLS_DIR)

			expect(result.phaseB.succeeded).not.toContain("unified-skill")
			expect(result.phaseB.failed).toHaveLength(1)
			expect(result.phaseB.failed[0].error).toContain('Skill "missing-skill" not found')
		})
	})

	describe("result structure", () => {
		it("returns correct structure when both phases have activity", async () => {
			const report: CuratorReport = {
				autoTransitions: {
					checked: [],
					proposeStale: ["stale-skill"],
					proposeArchive: ["archive-skill"],
					proposeReactivate: ["active-skill"],
				},
				consolidationProposals: [
					{
						umbrella: "consolidated",
						members: ["a", "b"],
						rationale: "Merge",
						strategy: "create_new",
					},
				],
				skillGaps: [],
				qualityIssues: [],
			}

			const result = await executeReport(report, SKILLS_DIR)

			expect(result.phaseA.success).toBe(true)
			expect(result.phaseA.error).toBeUndefined()
			expect(result.phaseB.succeeded).toEqual(["consolidated"])
			expect(result.phaseB.failed).toEqual([])
		})

		it("reports multiple successful and failed consolidations", async () => {
			mockManager.create.mockImplementation(async (name: string) => {
				if (name.includes("broken")) {
					return { success: false, error: "Creation failed" }
				}
				return { success: true }
			})

			const report: CuratorReport = {
				autoTransitions: { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] },
				consolidationProposals: [
					{
						umbrella: "skill-1",
						members: ["member-1"],
						rationale: "OK",
						strategy: "create_new",
					},
					{
						umbrella: "broken-skill",
						members: ["member-2"],
						rationale: "Fail",
						strategy: "create_new",
					},
					{
						umbrella: "skill-3",
						members: ["member-3"],
						rationale: "OK",
						strategy: "create_new",
					},
				],
				skillGaps: [],
				qualityIssues: [],
			}

			const result = await executeReport(report, SKILLS_DIR)

			expect(result.phaseB.succeeded).toEqual(["skill-1", "skill-3"])
			expect(result.phaseB.failed).toHaveLength(1)
			expect(result.phaseB.failed[0].proposal).toBe("broken-skill")
		})
	})
})
