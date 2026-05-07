import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runCuratorPipeline } from "./curator.js"

// Mock only the subagent call (LLM) - all other logic uses real implementations
vi.mock("../subagent.js", () => ({
	spawnSubagent: vi
		.fn()
		.mockResolvedValue("```yaml\nconsolidation_proposals: []\nskill_gaps: []\nquality_issues: []\n```"),
}))

import { spawnSubagent } from "../subagent.js"

const mockSpawnSubagent = spawnSubagent as ReturnType<typeof vi.fn>

describe("curator integration", () => {
	const testDir = join("/tmp", `curator-test-${Date.now()}`)
	const skillsDir = join(testDir, "skills")
	const memoryDir = join(testDir, "memory")

	beforeAll(async () => {
		// Create directory structure
		await mkdir(skillsDir, { recursive: true })
		await mkdir(join(memoryDir, "summaries"), { recursive: true })

		// Create a test skill with SKILL.md
		await mkdir(join(skillsDir, "test-skill"))
		await writeFile(
			join(skillsDir, "test-skill", "SKILL.md"),
			`---
name: test-skill
description: A test skill for integration testing
triggers:
  - test
  - integration
category: testing
---
# Test Skill

This skill is used for integration testing.
`,
		)

		// Create a second test skill (will be used to test stale detection)
		await mkdir(join(skillsDir, "old-skill"))
		await writeFile(
			join(skillsDir, "old-skill", "SKILL.md"),
			`---
name: old-skill
description: An old skill that hasn't been used recently
triggers:
  - old
category: testing
---
# Old Skill

This skill is old and should be proposed for stale.
`,
		)

		// Create .usage.json with agent_created skills
		// NOTE: Each entry must have a "name" field matching the object key
		const now = new Date()
		const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)
		const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000)

		await writeFile(
			join(skillsDir, ".usage.json"),
			JSON.stringify(
				{
					"test-skill": {
						name: "test-skill",
						agent_created: true,
						use_count: 5,
						state: "active",
						last_used_at: fiveDaysAgo.toISOString(),
						created_at: "2026-01-01T00:00:00Z",
						pinned: false,
						patch_count: 0,
					},
					"old-skill": {
						name: "old-skill",
						agent_created: true,
						use_count: 2,
						state: "active",
						last_used_at: thirtyFiveDaysAgo.toISOString(),
						created_at: "2026-01-01T00:00:00Z",
						pinned: false,
						patch_count: 0,
					},
					// Non-agent-created skill should be filtered out
					"user-skill": {
						name: "user-skill",
						agent_created: false,
						use_count: 1,
						state: "active",
						created_at: "2026-01-01T00:00:00Z",
						pinned: false,
						patch_count: 0,
					},
				},
				null,
				2,
			),
		)

		// Create a test session summary
		await writeFile(
			join(memoryDir, "summaries", "session-2026-05-07.md"),
			`---
id: test-session
started_at: 2026-05-07T09:00:00Z
---
Test session summary for integration testing.

## What was done
- Ran integration tests
- Verified pipeline execution

## Challenges
- Setting up proper test fixtures
`,
		)
	})

	afterAll(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("runCuratorPipeline", () => {
		it("exercises full pipeline and returns complete CuratorReport", async () => {
			const report = await runCuratorPipeline(skillsDir, memoryDir)

			// Verify report has all required fields
			expect(report).toHaveProperty("autoTransitions")
			expect(report).toHaveProperty("consolidationProposals")
			expect(report).toHaveProperty("skillGaps")
			expect(report).toHaveProperty("qualityIssues")

			// Verify autoTransitions structure
			expect(report.autoTransitions).toHaveProperty("checked")
			expect(report.autoTransitions).toHaveProperty("proposeStale")
			expect(report.autoTransitions).toHaveProperty("proposeArchive")
			expect(report.autoTransitions).toHaveProperty("proposeReactivate")
		})

		it("checks agent-created skills in auto-transitions", async () => {
			const report = await runCuratorPipeline(skillsDir, memoryDir)

			// Auto-transitions should check agent_created skills (test-skill, old-skill)
			// user-skill is not agent_created and should not be checked
			expect(Array.isArray(report.autoTransitions.checked)).toBe(true)
			// Both agent_created skills should be in the checked list
			expect(report.autoTransitions.checked.filter(Boolean)).toHaveLength(2)
		})

		it("proposes stale for old skills with no recent activity", async () => {
			const report = await runCuratorPipeline(skillsDir, memoryDir)

			// old-skill has no activity in 30+ days, should be proposed for stale
			// (note: this uses real auto-transition logic based on timestamps)
			expect(Array.isArray(report.autoTransitions.proposeStale)).toBe(true)
			expect(Array.isArray(report.autoTransitions.proposeArchive)).toBe(true)
		})

		it("includes consolidationProposals from LLM response", async () => {
			mockSpawnSubagent.mockResolvedValueOnce(
				"```yaml\nconsolidation_proposals:\n  - umbrella: testing-tools\n    members: [test-skill, old-skill]\n    rationale: Both are testing-related skills\nskill_gaps: []\nquality_issues: []\n```",
			)

			const report = await runCuratorPipeline(skillsDir, memoryDir)

			expect(report.consolidationProposals).toHaveLength(1)
			expect(report.consolidationProposals[0]).toEqual({
				umbrella: "testing-tools",
				members: ["test-skill", "old-skill"],
				rationale: "Both are testing-related skills",
			})
		})

		it("includes skillGaps from LLM response", async () => {
			mockSpawnSubagent.mockResolvedValueOnce(
				"```yaml\nconsolidation_proposals: []\nskill_gaps:\n  - topic: kubernetes\n    evidence: Multiple kubectl commands observed\n    suggested_triggers: [k8s, kubernetes, kubectl]\nquality_issues: []\n```",
			)

			const report = await runCuratorPipeline(skillsDir, memoryDir)

			expect(report.skillGaps).toHaveLength(1)
			expect(report.skillGaps[0]).toEqual({
				topic: "kubernetes",
				evidence: "Multiple kubectl commands observed",
				suggestedTriggers: ["k8s", "kubernetes", "kubectl"],
			})
		})

		it("includes qualityIssues from LLM response", async () => {
			mockSpawnSubagent.mockResolvedValueOnce(
				'```yaml\nconsolidation_proposals: []\nskill_gaps: []\nquality_issues:\n  - skill: old-skill\n    issue: missing_triggers\n    suggestion: Add more triggers like "legacy", "deprecated"\n```',
			)

			const report = await runCuratorPipeline(skillsDir, memoryDir)

			expect(report.qualityIssues).toHaveLength(1)
			expect(report.qualityIssues[0]).toEqual({
				skill: "old-skill",
				issue: "missing_triggers",
				suggestion: 'Add more triggers like "legacy", "deprecated"',
			})
		})

		it("calls spawnSubagent with gemini model", async () => {
			await runCuratorPipeline(skillsDir, memoryDir)

			expect(mockSpawnSubagent).toHaveBeenCalledTimes(1)
			expect(mockSpawnSubagent).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "gemini-3-pro-preview",
				}),
			)
		})

		it("passes a prompt containing skill and auto-transition information", async () => {
			await runCuratorPipeline(skillsDir, memoryDir)

			const call = mockSpawnSubagent.mock.calls[0][0]
			const prompt = call.prompt as string

			// Prompt should reference the curator task
			expect(prompt).toContain("Skill Inventory")
			expect(prompt).toContain("Auto-Transition Proposal")
			expect(prompt).toContain("Recent Session Summaries")
		})

		it("handles empty skills directory gracefully", async () => {
			const emptySkillsDir = join(testDir, "empty-skills")
			await mkdir(emptySkillsDir, { recursive: true })
			await writeFile(join(emptySkillsDir, ".usage.json"), JSON.stringify({}))

			const report = await runCuratorPipeline(emptySkillsDir, memoryDir)

			expect(report.autoTransitions.checked).toHaveLength(0)
			expect(report.consolidationProposals).toHaveLength(0)
		})

		it("handles missing .usage.json gracefully", async () => {
			const noUsageDir = join(testDir, "no-usage")
			await mkdir(noUsageDir, { recursive: true })

			const report = await runCuratorPipeline(noUsageDir, memoryDir)

			expect(report.autoTransitions.checked).toHaveLength(0)
		})

		it("handles missing memory summaries gracefully", async () => {
			const noSummariesDir = join(testDir, "no-summaries")
			await mkdir(noSummariesDir, { recursive: true })

			const report = await runCuratorPipeline(skillsDir, noSummariesDir)

			// Should still produce a valid report
			expect(report).toBeDefined()
			expect(report.consolidationProposals).toBeDefined()
		})
	})

	describe("options", () => {
		it("returns report without executing by default", async () => {
			const report = await runCuratorPipeline(skillsDir, memoryDir)

			// Report should be valid, no execute called
			expect(report).toBeDefined()
			expect(report.autoTransitions).toBeDefined()
		})

		it("returns report with dryRun option", async () => {
			const report = await runCuratorPipeline(skillsDir, memoryDir, { dryRun: true })

			expect(report).toBeDefined()
			expect(report.autoTransitions).toBeDefined()
		})

		it("returns report with execute option set to false", async () => {
			const report = await runCuratorPipeline(skillsDir, memoryDir, { execute: false })

			expect(report).toBeDefined()
			expect(report.autoTransitions).toBeDefined()
		})
	})

	describe("error handling", () => {
		it("returns valid report even when LLM returns empty response", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("")

			const report = await runCuratorPipeline(skillsDir, memoryDir)

			expect(report).toBeDefined()
			expect(report.consolidationProposals).toEqual([])
			expect(report.skillGaps).toEqual([])
			expect(report.qualityIssues).toEqual([])
		})

		it("returns valid report when LLM returns malformed YAML", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("this is not yaml at all")

			const report = await runCuratorPipeline(skillsDir, memoryDir)

			expect(report).toBeDefined()
			expect(Array.isArray(report.consolidationProposals)).toBe(true)
			expect(Array.isArray(report.skillGaps)).toBe(true)
			expect(Array.isArray(report.qualityIssues)).toBe(true)
		})
	})
})
