import { beforeEach, describe, expect, it, vi } from "vitest"
import { executeReport } from "./executor.js"
import type { CuratorReport } from "./types.js"

vi.mock("../skills-manager/usage.js", async () => {
	const actual = await vi.importActual("../skills-manager/usage.js")
	return {
		...actual,
		setStateBatch: vi.fn(),
	}
})

vi.mock("../skills-manager/skill-manager.js", async () => {
	const actual = await vi.importActual("../skills-manager/skill-manager.js")
	return {
		...actual,
		archiveSkill: vi.fn(),
		skillExists: vi.fn(),
	}
})

import { archiveSkill, skillExists } from "../skills-manager/skill-manager.js"
import { setStateBatch } from "../skills-manager/usage.js"

const mockSetStateBatch = setStateBatch as ReturnType<typeof vi.fn>
const mockArchiveSkill = archiveSkill as ReturnType<typeof vi.fn>
const mockSkillExists = skillExists as ReturnType<typeof vi.fn>

describe("executeReport", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Default: all skills exist
		mockSkillExists.mockResolvedValue(true)
		// Default: successful state changes
		mockSetStateBatch.mockResolvedValue(undefined)
		// Default: successful archive
		mockArchiveSkill.mockResolvedValue(true)
	})

	it("executes reactivate transitions in Phase A", async () => {
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

		await executeReport(report)

		expect(mockSetStateBatch).toHaveBeenCalledWith([
			{ name: "skill-a", state: "active" },
			{ name: "skill-b", state: "active" },
		])
	})

	it("executes stale transitions in Phase A", async () => {
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

		await executeReport(report)

		expect(mockSetStateBatch).toHaveBeenCalledWith([
			{ name: "skill-x", state: "stale" },
			{ name: "skill-y", state: "stale" },
		])
	})

	it("archives skills in Phase A", async () => {
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

		await executeReport(report)

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

		await expect(executeReport(report)).rejects.toThrow("Disk full")

		// Archive should not have been called since Phase A failed
		expect(mockArchiveSkill).not.toHaveBeenCalled()
	})

	it("Phase B executes valid consolidations", async () => {
		const report: CuratorReport = {
			autoTransitions: {
				checked: [],
				proposeStale: [],
				proposeArchive: [],
				proposeReactivate: [],
			},
			consolidationProposals: [
				{
					umbrella: "unified-skill",
					members: ["skill-1", "skill-2"],
					rationale: "Combine similar skills",
					strategy: "merge_into_existing",
				},
			],
			skillGaps: [],
			qualityIssues: [],
		}

		const result = await executeReport(report)

		expect(result.phaseB.succeeded).toContain("unified-skill")
		expect(result.phaseB.failed).toHaveLength(0)
	})

	it("Phase B skips consolidation if member not found", async () => {
		mockSkillExists.mockImplementation(async (name: string) => name !== "missing-skill")

		const report: CuratorReport = {
			autoTransitions: {
				checked: [],
				proposeStale: [],
				proposeArchive: [],
				proposeReactivate: [],
			},
			consolidationProposals: [
				{
					umbrella: "unified-skill",
					members: ["skill-1", "missing-skill"],
					rationale: "Combine skills",
					strategy: "merge_into_existing",
				},
			],
			skillGaps: [],
			qualityIssues: [],
		}

		const result = await executeReport(report)

		expect(result.phaseB.succeeded).not.toContain("unified-skill")
		expect(result.phaseB.failed).toHaveLength(1)
		expect(result.phaseB.failed[0].proposal).toBe("unified-skill")
		expect(result.phaseB.failed[0].error).toContain('Skill "missing-skill" not found')
	})

	it("Phase B continues on consolidation failure (skip & warn)", async () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		const report: CuratorReport = {
			autoTransitions: {
				checked: [],
				proposeStale: [],
				proposeArchive: [],
				proposeReactivate: [],
			},
			consolidationProposals: [
				{
					umbrella: "broken-skill",
					members: ["member-a"],
					rationale: "This will fail",
					strategy: "merge_into_existing",
				},
				{
					umbrella: "good-skill",
					members: ["member-b"],
					rationale: "This will succeed",
					strategy: "merge_into_existing",
				},
			],
			skillGaps: [],
			qualityIssues: [],
		}

		// Make first consolidation fail
		mockSkillExists.mockImplementation(async (name: string) => {
			if (name === "member-a") throw new Error("Unexpected error")
			return true
		})

		const result = await executeReport(report)

		expect(result.phaseB.failed).toHaveLength(1)
		expect(result.phaseB.failed[0].proposal).toBe("broken-skill")
		// Second consolidation should have succeeded despite first failing
		expect(result.phaseB.succeeded).toContain("good-skill")

		consoleSpy.mockRestore()
	})

	it("returns correct result structure when both phases have activity", async () => {
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
					strategy: "merge_into_existing",
				},
			],
			skillGaps: [],
			qualityIssues: [],
		}

		const result = await executeReport(report)

		expect(result.phaseA.success).toBe(true)
		expect(result.phaseA.error).toBeUndefined()
		expect(result.phaseB.succeeded).toEqual(["consolidated"])
		expect(result.phaseB.failed).toEqual([])
	})
})
