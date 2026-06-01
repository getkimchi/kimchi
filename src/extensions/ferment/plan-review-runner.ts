import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { Static } from "typebox"
import { getVisibleSubagentSpawner } from "../agents/index.js"
import { runAgent } from "../agents/manager/agent-runner.js"
import { AGENT_PLAN_REVIEWER } from "../agents/personas/types.js"
import type { PlanReviewSchema } from "./tool-schemas.js"

export type PlanReview = Static<typeof PlanReviewSchema>

/** Wrap the canonical plan payload in the tags the Plan Reviewer persona expects.
 *  The persona prompt carries all behavioral guidance; this only delivers the plan. */
export function buildPlanReviewPrompt(planJson: string): string {
	return [
		"Review the following ferment implementation plan. The complete plan payload is the JSON object inside the <ferment_plan> tags below.",
		"Verify it against the actual codebase with your read-only tools, then submit your verdict by calling submit_plan_review exactly once.",
		"",
		"<ferment_plan>",
		planJson,
		"</ferment_plan>",
	].join("\n")
}

function asVerdict(structuredOutput: unknown): PlanReview {
	if (!structuredOutput || typeof structuredOutput !== "object") {
		throw new Error("Plan Reviewer returned no structured verdict.")
	}
	return structuredOutput as PlanReview
}

/** Spawn the Plan Reviewer on `planJson` and return its validated verdict.
 *  Routes through the shared AgentManager (TUI-visible) when available; otherwise
 *  calls runAgent directly. Throws if the reviewer never submits a verdict. */
export async function runHostPlanReview(
	ctx: unknown,
	pi: ExtensionAPI,
	planJson: string,
	signal?: AbortSignal,
): Promise<PlanReview> {
	const prompt = buildPlanReviewPrompt(planJson)
	// Preferred: spawn through the shared tracker+widget wiring so the reviewer
	// renders in the "● Agents" tree like any Explore/Plan agent.
	const spawnVisible = getVisibleSubagentSpawner()
	if (spawnVisible) {
		const record = await spawnVisible({
			pi,
			ctx: ctx as ExtensionContext,
			type: AGENT_PLAN_REVIEWER,
			prompt,
			description: "Reviewing the scoping plan",
			signal,
		})
		return asVerdict(record?.structuredOutput)
	}
	// Fallback (e.g. agents extension not active in some tests): direct run.
	const result = await runAgent(ctx as ExtensionContext, AGENT_PLAN_REVIEWER, prompt, { pi, signal })
	return asVerdict(result.structuredOutput)
}
