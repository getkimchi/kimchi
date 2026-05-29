/**
 * `submit_plan_review` — the Plan Reviewer persona's schema-bound output tool.
 *
 * Registered globally but active ONLY for the Plan Reviewer subagent (gated in
 * the agent-runner filter via AgentConfig.outputToolName). The reviewer returns
 * its verdict by calling this tool; the harness validates the args against
 * PlanReviewSchema, and the validated object becomes the subagent's
 * RunResult.structuredOutput — no free-text parsing, no drift.
 *
 * Deliberately NOT a member of FERMENT_TOOL_NAMES so FermentToolScope's
 * worker-profile gating (which disables every ferment tool for subagents) leaves
 * it alone — the Plan Reviewer is itself a worker.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Static } from "typebox"
import { setAgentStructuredOutput } from "../../agent-worker-context.js"
import { PLAN_REVIEW_SUBMIT_TOOL } from "../../agents/personas/types.js"
import { toolErr, toolOk } from "../tool-helpers.js"
import { PlanReviewSchema } from "../tool-schemas.js"

type PlanReview = Static<typeof PlanReviewSchema>

export function registerPlanReviewTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: PLAN_REVIEW_SUBMIT_TOOL,
		label: "Submit Plan Review",
		description:
			"Submit your plan-review verdict. Call this EXACTLY ONCE to return your result — do not reply with prose. " +
			"All fields are required; use [] for empty arrays. If any required_changes remain, status MUST be needs_revision; " +
			"approved means required_changes is [].",
		parameters: PlanReviewSchema,
		async execute(_, params: PlanReview) {
			// Semantic consistency the shape schema can't express. Reject so the
			// reviewer fixes it before the verdict is captured (no structured output
			// is recorded on the error path → the run treats it as not-yet-submitted).
			if (params.status === "needs_revision" && params.required_changes.length === 0) {
				return toolErr(
					"status is needs_revision but required_changes is empty. List the concrete changes, or set status to approved.",
				)
			}
			if (params.status === "approved" && params.required_changes.length > 0) {
				return toolErr(
					"status is approved but required_changes is non-empty. Clear required_changes, or set status to needs_revision.",
				)
			}
			setAgentStructuredOutput(params)
			return toolOk("Plan review submitted.")
		},
	})
}
