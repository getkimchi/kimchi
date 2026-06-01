/**
 * `submit_plan_review` — the Plan Reviewer persona's schema-bound output tool.
 *
 * The Plan Reviewer calls this in its OWN subagent session to return its verdict;
 * the harness validates the args against PlanReviewSchema, and the validated
 * object becomes the subagent's RunResult.structuredOutput — no free-text
 * parsing, no drift.
 *
 * Installed in two places, because the planner and the subagent are separate
 * sessions of the same in-process run:
 *   - the main/planner session, via fermentExtension init (where it is hidden
 *     from the planner by FermentToolScope — the planner must spawn the subagent,
 *     not self-submit);
 *   - the Plan Reviewer subagent session, via the persona-output-tools registry:
 *     the agent runner injects ONLY the spawning persona's own output tool, so the
 *     reviewer gets it and no other persona's session does. Subagent sessions do
 *     not load fermentExtension, so without this bridge the tool would not exist
 *     there and the reviewer's call would fail "Tool ... not found".
 *
 * Deliberately NOT a member of FERMENT_TOOL_NAMES so FermentToolScope's ferment
 * profiles never touch it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Static } from "typebox"
import { setAgentStructuredOutput } from "../../agent-worker-context.js"
import { registerPersonaOutputToolFactory } from "../../agents/persona-output-tools.js"
import { PLAN_REVIEW_SUBMIT_TOOL } from "../../agents/personas/types.js"
import { toolErr, toolOk } from "../tool-helpers.js"
import { PlanReviewSchema } from "../tool-schemas.js"

type PlanReview = Static<typeof PlanReviewSchema>

export function registerPlanReviewTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: PLAN_REVIEW_SUBMIT_TOOL,
		label: "Submit Plan Review",
		description:
			"Submit the Plan Reviewer verdict. Arguments must match PlanReviewSchema; the tool enforces status/required_changes consistency. See the Plan Reviewer system prompt for when to use each status.",
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
			setAgentStructuredOutput({ ...params })
			return toolOk("Plan review submitted.")
		},
	})
}

// Make the tool installable inside subagent sessions (which do not load
// fermentExtension). The agent runner injects every registered factory into the
// subagent extension loader; gating keeps it active only for the Plan Reviewer.
registerPersonaOutputToolFactory(PLAN_REVIEW_SUBMIT_TOOL, registerPlanReviewTool)
