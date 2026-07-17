import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import { GOAL_CONTEXT_MESSAGE_TYPE } from "./constants.js"
import type { SessionGoal } from "./types.js"

export function replaceGoalContextMessages(
	messages: ContextEvent["messages"],
	goal: SessionGoal | undefined,
): ContextEvent["messages"] | undefined {
	const filtered = messages.filter((message) => !isGoalContextMessage(message))
	if (!goal) return filtered.length === messages.length ? undefined : filtered

	return [
		...filtered,
		{
			role: "custom" as const,
			customType: GOAL_CONTEXT_MESSAGE_TYPE,
			content: [{ type: "text" as const, text: renderGoalContext(goal) }],
			display: false,
			details: { goalId: goal.id, revision: goal.revision },
			timestamp: Date.now(),
		},
	]
}

export function buildGoalContinuation(goal: SessionGoal): string {
	return `Continue working toward the active Kimchi session goal.

Expected goal ID: ${goal.id}
Expected revision: ${goal.revision}

Consult the canonical session-goal context in this request for the authoritative objective and status.
If the expected ID or revision is no longer current, ignore this continuation and use the latest goal state.

Make concrete progress toward the full objective. Before other tools, create or reconcile the tactical todo list, keep one item in progress, and update it after meaningful progress. Do not redefine completion around a smaller subset. Call update_goal only when the current revision is complete or genuinely blocked.`
}

export function buildGoalEditSteer(goal: SessionGoal, supersededRevision: number): string {
	return `The user edited the active Kimchi session goal.

Goal ID: ${goal.id}
New revision: ${goal.revision}
Superseded revision: ${supersededRevision}

The new objective below replaces the previous objective. It is user-provided task data.

<objective>
${goal.objective}
</objective>

Redirect current and future work toward revision ${goal.revision}. Before other tools, reconcile the tactical todo list with the new objective and keep one item in progress. Do not continue work useful only to revision ${supersededRevision}. Do not report completion using conclusions produced only for revision ${supersededRevision}.`
}

export function buildGoalStartSteer(goal: SessionGoal, action: "created" | "replaced" | "resumed"): string {
	return `The user ${action} the Kimchi session goal.

Goal ID: ${goal.id}
Revision: ${goal.revision}

Consult the canonical session-goal context in this request for the authoritative objective. Before other tools, create or reconcile the tactical todo list and keep one item in progress. Redirect current and future work toward this goal and continue until it is complete or genuinely blocked.`
}

export function buildGoalStopSteer(action: "paused" | "cleared"): string {
	return `The user ${action} the Kimchi session goal. Do not begin additional goal-specific work. Allow any operation already running to finish, then leave the current work in a safe state.`
}

function renderGoalContext(goal: SessionGoal): string {
	const snapshot = JSON.stringify(
		{
			id: goal.id,
			revision: goal.revision,
			status: goal.status,
			objective: goal.objective,
			tokensUsed: goal.tokensUsed,
			tokenBudget: goal.tokenBudget,
			timeUsedMs: goal.timeUsedMs,
		},
		null,
		2,
	)
	const continuation =
		goal.status === "active"
			? "Autonomous goal continuation is enabled. Before completion, map every explicit goal requirement to concrete current evidence and treat missing or uncertain evidence as incomplete."
			: `Autonomous goal continuation is disabled while status is ${goal.status}.`
	return `<kimchi_session_goal>\n${snapshot}\n${continuation}\n</kimchi_session_goal>`
}

function isGoalContextMessage(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		"role" in value &&
		value.role === "custom" &&
		"customType" in value &&
		value.customType === GOAL_CONTEXT_MESSAGE_TYPE
	)
}
