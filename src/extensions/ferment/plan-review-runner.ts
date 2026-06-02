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

/** The Plan Reviewer run was cancelled (turn aborted / signal / budget), not a
 *  genuine review outcome. Callers should NOT prompt the planner to "retry the
 *  same plan" — nothing about the plan caused it. */
export class PlanReviewAbortedError extends Error {
	constructor(reason?: string) {
		super(reason ? `Plan Reviewer was interrupted (${reason}).` : "Plan Reviewer was interrupted.")
		this.name = "PlanReviewAbortedError"
	}
}

function asVerdict(structuredOutput: unknown): PlanReview {
	if (!structuredOutput || typeof structuredOutput !== "object") {
		// Reached when the reviewer finished but never called submit_plan_review
		// (e.g. replied in prose). runAgent's output contract normally throws first.
		throw new Error("Plan Reviewer finished without submitting a verdict (did not call submit_plan_review).")
	}
	return structuredOutput as PlanReview
}

/** Spawn the Plan Reviewer on `planJson` and return its validated verdict.
 *  Routes through the shared AgentManager (TUI-visible) when available; otherwise
 *  calls runAgent directly. Throws PlanReviewAbortedError if the run was cancelled,
 *  or a descriptive Error if the reviewer errored / never submitted a verdict. */
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
		// The manager swallows run failures (resolves the record promise instead of
		// rejecting), so the verdict is trustworthy ONLY when the run completed
		// normally. Inspect the record's outcome before reading structuredOutput.
		if (!record) throw new Error("Plan Reviewer did not start.")
		if (record.status === "aborted" || record.status === "stopped") {
			throw new PlanReviewAbortedError(record.abortReason)
		}
		if (record.status === "error") {
			throw new Error(`Plan Reviewer failed: ${record.error ?? "unknown error"}`)
		}
		return asVerdict(record.structuredOutput)
	}
	// Fallback (e.g. agents extension not active in some tests): direct run.
	// runAgent throws on hard errors and returns aborted=true on cancellation.
	const result = await runAgent(ctx as ExtensionContext, AGENT_PLAN_REVIEWER, prompt, { pi, signal })
	if (result.aborted) throw new PlanReviewAbortedError(result.abortReason)
	return asVerdict(result.structuredOutput)
}
