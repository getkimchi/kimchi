import { spawnSubagent } from "../subagent.js"
import { applyAutoTransitions } from "./auto-transitions.js"
import { executeReport } from "./executor.js"
import { buildProjectedInventory, inventoryAgentSkills } from "./inventory.js"
import { summarizeLogs } from "./log-summarizer.js"
import { buildReviewPrompt, parseLLMResponse } from "./review-agent.js"
import type { CuratorReport } from "./types.js"

export async function runCuratorPipeline(
	skillsDir: string,
	memoryDir: string,
	options: { dryRun?: boolean; execute?: boolean } = {},
): Promise<CuratorReport> {
	// Step 1: Compute proposed transitions (no mutations)
	const proposal = await applyAutoTransitions(undefined, skillsDir)

	// Step 2: Build projected inventory (filter out proposed-archive)
	const allSkills = await inventoryAgentSkills(skillsDir)
	const projectedSkills = buildProjectedInventory(allSkills, proposal)

	// Step 3: Summarize logs
	const logs = await summarizeLogs(memoryDir)

	// Step 4: LLM review pass
	const prompt = buildReviewPrompt(projectedSkills, proposal, logs)
	const llmResponse = await spawnSubagent({
		prompt,
		model: "gemini-3-pro-preview",
	})
	const llmResults = parseLLMResponse(llmResponse)

	// Build full report
	const report: CuratorReport = {
		autoTransitions: proposal,
		consolidationProposals: llmResults.consolidationProposals,
		skillGaps: llmResults.skillGaps,
		qualityIssues: llmResults.qualityIssues,
	}

	// Step 5: Execute if approved
	if (options.execute) {
		await executeReport(report)
	}

	return report
}
