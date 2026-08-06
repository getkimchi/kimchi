/**
 * Ferment integration coverage for the Startup Environment Snapshot feature.
 *
 * Ferment does not own a third snapshot path. This file locks down the two
 * Ferment-specific boundaries around the shared prompt paths:
 * 1. The registered Grader persona accepts the snapshot supplied by the shared
 *    agent runner and keeps it as the final section.
 * 2. Tool-less judge.js calls bypass workspace prompts and remain snapshot-free.
 *
 * Main/planner finalization and linked-worker runner wiring are integration-tested
 * at their owning boundaries in prompt-enrichment.test.ts and agent-runner.test.ts.
 */
import { describe, expect, it, vi } from "vitest"
import { getAgentConfig, registerAgents } from "../agents/personas/agent-types.js"
import { buildAgentPrompt } from "../agents/prompt/prompts.js"
import {
	type JudgeApiResult,
	type JudgeJourneyGradeInput,
	type JudgePhaseInput,
	judgeJourneyGrade,
	judgePhaseGrade,
} from "./judge.js"

const SNAPSHOT_BLOCK =
	"<!-- kimchi:environment-snapshot:start -->\n## Startup Environment Snapshot\ngrader cwd snapshot\n<!-- kimchi:environment-snapshot:end -->"

describe("Ferment workspace-agent snapshot coverage", () => {
	it.each([
		"Builder",
		"Reviewer",
		"Grader",
	] as const)("%s agent prompt ends with exactly one snapshot block", (agentType) => {
		registerAgents(new Map())
		const cfg = getAgentConfig(agentType)
		expect(cfg).toBeDefined()
		if (!cfg) return

		const prompt = buildAgentPrompt(
			cfg,
			"/repo",
			{ isGitRepo: true, branch: "main", platform: "linux" },
			"parent system prompt",
			{ environmentSnapshot: SNAPSHOT_BLOCK },
		)

		const matches = prompt.match(/kimchi:environment-snapshot:start/g)
		expect(matches).toHaveLength(1)
		expect(prompt.trimEnd().endsWith(SNAPSHOT_BLOCK)).toBe(true)
	})

	it("Grader agent prompt omits the snapshot block when extras.environmentSnapshot is undefined", () => {
		registerAgents(new Map())
		const cfg = getAgentConfig("Grader")
		expect(cfg).toBeDefined()
		if (!cfg) return

		const prompt = buildAgentPrompt(
			cfg,
			"/repo",
			{ isGitRepo: true, branch: "main", platform: "linux" },
			"parent system prompt",
		)

		expect(prompt).not.toContain("kimchi:environment-snapshot")
	})
})

describe("Ferment judge.js prompts are snapshot-free (tool-less)", () => {
	function ok(text: string): JudgeApiResult {
		return { ok: true, text }
	}

	it("judgeJourneyGrade system prompt contains no snapshot markers", async () => {
		let capturedSystem = ""
		const apiCall = vi.fn(async (sys: string, _msg: string) => {
			capturedSystem = sys
			return ok('{"grade":"A","rationale":"x"}')
		})
		const input: JudgeJourneyGradeInput = {
			fermentName: "T",
			goal: "g",
			successCriteria: "c",
			finalSummary: "s",
			phases: [],
			fermentGates: [],
			totalDiff: { available: false },
		}
		await judgeJourneyGrade(input, apiCall)
		expect(capturedSystem).not.toContain("kimchi:environment-snapshot")
		expect(capturedSystem).not.toContain("Startup Environment Snapshot")
	})

	it("judgePhaseGrade system prompt contains no snapshot markers", async () => {
		let capturedSystem = ""
		const apiCall = vi.fn(async (sys: string, _msg: string) => {
			capturedSystem = sys
			return ok('{"grade":"A","rationale":"x","recommendations":[]}')
		})
		const input: JudgePhaseInput = {
			fermentName: "T",
			phaseName: "P1",
			phaseGoal: "g",
			phaseSummary: "s",
			stepSummaries: "",
			gateVerdicts: [],
			projectChecksSummary: "",
			phaseDiff: { available: false },
		}
		await judgePhaseGrade(input, apiCall)
		expect(capturedSystem).not.toContain("kimchi:environment-snapshot")
		expect(capturedSystem).not.toContain("Startup Environment Snapshot")
	})
})
