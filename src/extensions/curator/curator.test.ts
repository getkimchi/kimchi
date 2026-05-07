import { beforeEach, describe, expect, it, vi } from "vitest"
import { runCuratorPipeline } from "./curator.js"
import type { CuratorReport } from "./types.js"

// Mock dependencies
vi.mock("./auto-transitions.js", () => ({
	applyAutoTransitions: vi.fn(),
}))

vi.mock("./inventory.js", () => ({
	inventoryAgentSkills: vi.fn(),
	buildProjectedInventory: vi.fn(),
}))

vi.mock("./log-summarizer.js", () => ({
	summarizeLogs: vi.fn(),
}))

vi.mock("./review-agent.js", () => ({
	buildReviewPrompt: vi.fn(),
	parseLLMResponse: vi.fn(),
}))

vi.mock("./executor.js", () => ({
	executeReport: vi.fn(),
}))

vi.mock("../subagent.js", () => ({
	spawnSubagent: vi.fn(),
}))

import { spawnSubagent } from "../subagent.js"
import { applyAutoTransitions } from "./auto-transitions.js"
import { executeReport } from "./executor.js"
import { buildProjectedInventory, inventoryAgentSkills } from "./inventory.js"
import { summarizeLogs } from "./log-summarizer.js"
import { buildReviewPrompt, parseLLMResponse } from "./review-agent.js"

const mockApplyAutoTransitions = applyAutoTransitions as ReturnType<typeof vi.fn>
const mockInventoryAgentSkills = inventoryAgentSkills as ReturnType<typeof vi.fn>
const mockBuildProjectedInventory = buildProjectedInventory as ReturnType<typeof vi.fn>
const mockSummarizeLogs = summarizeLogs as ReturnType<typeof vi.fn>
const mockBuildReviewPrompt = buildReviewPrompt as ReturnType<typeof vi.fn>
const mockParseLLMResponse = parseLLMResponse as ReturnType<typeof vi.fn>
const mockExecuteReport = executeReport as ReturnType<typeof vi.fn>
const mockSpawnSubagent = spawnSubagent as ReturnType<typeof vi.fn>

describe("runCuratorPipeline", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Default mock implementations
		mockApplyAutoTransitions.mockResolvedValue({
			checked: [],
			proposeStale: [],
			proposeArchive: [],
			proposeReactivate: [],
		})
		mockInventoryAgentSkills.mockResolvedValue([])
		mockBuildProjectedInventory.mockReturnValue([])
		mockSummarizeLogs.mockResolvedValue({ summaries: [], failurePatterns: [] })
		mockBuildReviewPrompt.mockReturnValue("mock prompt")
		mockParseLLMResponse.mockReturnValue({
			consolidationProposals: [],
			skillGaps: [],
			qualityIssues: [],
		})
		mockSpawnSubagent.mockResolvedValue("mock LLM response")
		mockExecuteReport.mockResolvedValue({
			phaseA: { success: true },
			phaseB: { succeeded: [], failed: [] },
		})
	})

	const skillsDir = "/skills"
	const memoryDir = "/memory"

	describe("runs all pipeline steps in correct order", () => {
		it("applies auto-transitions first", async () => {
			await runCuratorPipeline(skillsDir, memoryDir)

			expect(mockApplyAutoTransitions).toHaveBeenCalledTimes(1)
			expect(mockApplyAutoTransitions).toHaveBeenCalledWith(undefined, skillsDir)
		})

		it("builds inventory from skills and proposal", async () => {
			const skills = [
				{
					name: "test-skill",
					description: "test",
					triggers: [],
					category: "test",
					state: "active",
					useCount: 0,
					lastUsedAt: null,
					agentCreated: true,
				},
			]
			mockInventoryAgentSkills.mockResolvedValue(skills)

			await runCuratorPipeline(skillsDir, memoryDir)

			expect(mockInventoryAgentSkills).toHaveBeenCalledTimes(1)
			expect(mockInventoryAgentSkills).toHaveBeenCalledWith(skillsDir)
		})

		it("summarizes logs after inventory", async () => {
			await runCuratorPipeline(skillsDir, memoryDir)

			// Should be called after applyAutoTransitions and inventoryAgentSkills
			expect(mockSummarizeLogs).toHaveBeenCalledTimes(1)
			expect(mockSummarizeLogs).toHaveBeenCalledWith(memoryDir)
		})

		it("builds review prompt with inventory, proposal, and logs", async () => {
			const projectedSkills = [
				{
					name: "skill-a",
					description: "A",
					triggers: [],
					category: "cat",
					state: "active",
					useCount: 0,
					lastUsedAt: null,
					agentCreated: true,
				},
			]
			const proposal = { checked: ["skill-a"], proposeStale: [], proposeArchive: [], proposeReactivate: [] }
			const logs = { summaries: ["summary 1"], failurePatterns: [] }

			mockBuildProjectedInventory.mockReturnValue(projectedSkills)
			mockApplyAutoTransitions.mockResolvedValue(proposal)
			mockSummarizeLogs.mockResolvedValue(logs)

			await runCuratorPipeline(skillsDir, memoryDir)

			expect(mockBuildReviewPrompt).toHaveBeenCalledTimes(1)
			expect(mockBuildReviewPrompt).toHaveBeenCalledWith(projectedSkills, proposal, logs)
		})

		it("spawns subagent with review prompt", async () => {
			const prompt = "detailed review prompt"
			mockBuildReviewPrompt.mockReturnValue(prompt)

			await runCuratorPipeline(skillsDir, memoryDir)

			expect(mockSpawnSubagent).toHaveBeenCalledTimes(1)
			expect(mockSpawnSubagent).toHaveBeenCalledWith({
				prompt,
				model: "gemini-3-pro-preview",
			})
		})

		it("parses LLM response", async () => {
			const llmResponse = "yaml response content"
			mockSpawnSubagent.mockResolvedValue(llmResponse)

			await runCuratorPipeline(skillsDir, memoryDir)

			expect(mockParseLLMResponse).toHaveBeenCalledTimes(1)
			expect(mockParseLLMResponse).toHaveBeenCalledWith(llmResponse)
		})
	})

	describe("returns full CuratorReport", () => {
		it("includes autoTransitions from applyAutoTransitions", async () => {
			const proposal = {
				checked: ["skill-a"],
				proposeStale: ["skill-stale"],
				proposeArchive: [],
				proposeReactivate: [],
			}
			mockApplyAutoTransitions.mockResolvedValue(proposal)

			const report = await runCuratorPipeline(skillsDir, memoryDir)

			expect(report.autoTransitions).toEqual(proposal)
		})

		it("includes consolidationProposals from parseLLMResponse", async () => {
			const consolidations = [{ umbrella: "unified", members: ["a", "b"], rationale: "merge" }]
			mockParseLLMResponse.mockReturnValue({
				consolidationProposals: consolidations,
				skillGaps: [],
				qualityIssues: [],
			})

			const report = await runCuratorPipeline(skillsDir, memoryDir)

			expect(report.consolidationProposals).toEqual(consolidations)
		})

		it("includes skillGaps from parseLLMResponse", async () => {
			const skillGaps = [{ topic: "testing", evidence: "no test skills", suggestedTriggers: ["test", "spec"] }]
			mockParseLLMResponse.mockReturnValue({
				consolidationProposals: [],
				skillGaps,
				qualityIssues: [],
			})

			const report = await runCuratorPipeline(skillsDir, memoryDir)

			expect(report.skillGaps).toEqual(skillGaps)
		})

		it("includes qualityIssues from parseLLMResponse", async () => {
			const qualityIssues = [
				{ skill: "bad-skill", issue: "missing_description" as const, suggestion: "add description" },
			]
			mockParseLLMResponse.mockReturnValue({
				consolidationProposals: [],
				skillGaps: [],
				qualityIssues,
			})

			const report = await runCuratorPipeline(skillsDir, memoryDir)

			expect(report.qualityIssues).toEqual(qualityIssues)
		})

		it("returns complete CuratorReport with all fields", async () => {
			const proposal = {
				checked: ["a", "b"],
				proposeStale: ["b"],
				proposeArchive: [],
				proposeReactivate: [],
			}
			const consolidations = [{ umbrella: "u", members: ["a"], rationale: "r" }]
			const gaps = [{ topic: "t", evidence: "e", suggestedTriggers: ["t1"] }]
			const issues = [{ skill: "s", issue: "unclear" as const, suggestion: "fix" }]

			mockApplyAutoTransitions.mockResolvedValue(proposal)
			mockParseLLMResponse.mockReturnValue({
				consolidationProposals: consolidations,
				skillGaps: gaps,
				qualityIssues: issues,
			})

			const report = await runCuratorPipeline(skillsDir, memoryDir)

			expect(report).toEqual({
				autoTransitions: proposal,
				consolidationProposals: consolidations,
				skillGaps: gaps,
				qualityIssues: issues,
			})
		})
	})

	describe("execute option", () => {
		it("does NOT call executeReport by default", async () => {
			await runCuratorPipeline(skillsDir, memoryDir)

			expect(mockExecuteReport).not.toHaveBeenCalled()
		})

		it("calls executeReport when execute option is true", async () => {
			const expectedReport: CuratorReport = {
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

			await runCuratorPipeline(skillsDir, memoryDir, { execute: true })

			expect(mockExecuteReport).toHaveBeenCalledTimes(1)
			expect(mockExecuteReport).toHaveBeenCalledWith(expectedReport)
		})

		it("does NOT call executeReport when execute option is false", async () => {
			await runCuratorPipeline(skillsDir, memoryDir, { execute: false })

			expect(mockExecuteReport).not.toHaveBeenCalled()
		})

		it("passes correct report to executeReport", async () => {
			const proposal = {
				checked: ["a"],
				proposeStale: [],
				proposeArchive: ["z"],
				proposeReactivate: [],
			}
			const consolidations = [{ umbrella: "u", members: ["a"], rationale: "r" }]

			mockApplyAutoTransitions.mockResolvedValue(proposal)
			mockParseLLMResponse.mockReturnValue({
				consolidationProposals: consolidations,
				skillGaps: [],
				qualityIssues: [],
			})

			await runCuratorPipeline(skillsDir, memoryDir, { execute: true })

			expect(mockExecuteReport).toHaveBeenCalledWith({
				autoTransitions: proposal,
				consolidationProposals: consolidations,
				skillGaps: [],
				qualityIssues: [],
			})
		})
	})

	describe("buildProjectedInventory integration", () => {
		it("passes allSkills and proposal to buildProjectedInventory", async () => {
			const allSkills = [
				{
					name: "skill-1",
					description: "d1",
					triggers: [],
					category: "c",
					state: "active",
					useCount: 1,
					lastUsedAt: "2026-01-01",
					agentCreated: true,
				},
				{
					name: "skill-2",
					description: "d2",
					triggers: [],
					category: "c",
					state: "active",
					useCount: 2,
					lastUsedAt: "2026-01-01",
					agentCreated: true,
				},
			]
			const proposal = {
				checked: ["skill-1", "skill-2"],
				proposeStale: [],
				proposeArchive: ["skill-2"],
				proposeReactivate: [],
			}
			const projectedSkills = [allSkills[0]] // skill-2 filtered out

			mockInventoryAgentSkills.mockResolvedValue(allSkills)
			mockApplyAutoTransitions.mockResolvedValue(proposal)
			mockBuildProjectedInventory.mockReturnValue(projectedSkills)

			await runCuratorPipeline(skillsDir, memoryDir)

			expect(mockBuildProjectedInventory).toHaveBeenCalledWith(allSkills, proposal)
		})

		it("builds projected inventory before building review prompt", async () => {
			const callOrder: string[] = []

			mockApplyAutoTransitions.mockImplementation(async () => {
				callOrder.push("autoTransitions")
				return { checked: [], proposeStale: [], proposeArchive: [], proposeReactivate: [] }
			})
			mockInventoryAgentSkills.mockImplementation(async () => {
				callOrder.push("inventoryAgentSkills")
				return []
			})
			mockBuildProjectedInventory.mockImplementation(() => {
				callOrder.push("buildProjectedInventory")
				return []
			})
			mockSummarizeLogs.mockImplementation(async () => {
				callOrder.push("summarizeLogs")
				return { summaries: [], failurePatterns: [] }
			})
			mockBuildReviewPrompt.mockImplementation(() => {
				callOrder.push("buildReviewPrompt")
				return "p"
			})

			await runCuratorPipeline(skillsDir, memoryDir)

			const promptIndex = callOrder.indexOf("buildReviewPrompt")
			const invIndex = callOrder.indexOf("inventoryAgentSkills")
			const projIndex = callOrder.indexOf("buildProjectedInventory")

			expect(promptIndex).toBeGreaterThan(invIndex)
			expect(promptIndex).toBeGreaterThan(projIndex)
		})
	})
})
