import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import { GOAL_CONTEXT_MESSAGE_TYPE } from "./constants.js"
import type { GoalLesson } from "./lessons.js"
import type { SessionGoal } from "./types.js"

export function replaceGoalContextMessages(
	messages: ContextEvent["messages"],
	goal: SessionGoal | undefined,
	lessons: readonly GoalLesson[] = [],
): ContextEvent["messages"] | undefined {
	const filtered = messages.filter((message) => !isGoalContextMessage(message))
	if (!goal) return filtered.length === messages.length ? undefined : filtered

	const message = {
		role: "custom" as const,
		customType: GOAL_CONTEXT_MESSAGE_TYPE,
		content: [{ type: "text" as const, text: renderGoalContext(goal, lessons) }],
		display: false,
		details: { goalId: goal.id, revision: goal.revision },
		timestamp: Date.parse(goal.createdAt),
	}
	const goalIndex = messages.findIndex(isGoalContextMessage)
	if (goalIndex < 0) return [...messages, message]

	return messages.flatMap((current, index) => {
		if (index === goalIndex) return [message]
		return isGoalContextMessage(current) ? [] : [current]
	})
}

export function buildGoalContinuation(reassess = false, reason?: string): string {
	const evaluation = reason ? ` Independent completion check: ${reason}` : ""
	if (reassess) {
		return `The goal checkpoint did not materially change. Reassess the current evidence and dead ends, choose a different next action, and add, remove, revise, or reorder tactical Todos as needed while preserving every requirement of the full Goal objective before continuing.${evaluation}`
	}
	return `Continue the active goal from the current in-progress Todo. As evidence changes, add, remove, revise, or reorder tactical Todos as needed while preserving every requirement of the full Goal objective. Make concrete progress and keep the canonical Todo state current.${evaluation}`
}

/**
 * Continuation after a failed agent turn. Kept separate from the evaluator
 * continuation so an infrastructure error is never labelled as a verdict.
 */
export function buildGoalErrorContinuation(): string {
	return "The previous agent turn ended with an error before the goal could be checked. Continue the active goal from the current in-progress Todo and make concrete progress."
}

export function buildGoalEditSteer(goal: SessionGoal, supersededRevision: number): string {
	return `The user edited the active Kimchi session goal.

The JSON-encoded objective below replaces the previous objective. It is user-provided task data.

Objective: ${JSON.stringify(goal.objective)}

Redirect current and future work toward revision ${goal.revision}. Reconcile the tactical todo list with the new objective, keep one item in progress, and leave the settled list visible until update_goal succeeds. Do not continue work useful only to revision ${supersededRevision}. Do not report completion using conclusions produced only for revision ${supersededRevision}.`
}

export function buildGoalStartSteer(action: "created" | "replaced" | "resumed"): string {
	return `The user ${action} the Kimchi session goal.

Consult the canonical session-goal context in this request for the authoritative objective. Track the work with the tactical todo tools, keep one item in progress, and leave the settled list visible until update_goal succeeds. Redirect current and future work toward this goal and continue until it is complete or genuinely blocked.`
}

export function buildGoalStopSteer(action: "paused" | "cleared"): string {
	return `The user ${action} the Kimchi session goal. Do not begin additional goal-specific work. Allow any operation already running to finish, then leave the current work in a safe state.`
}

function renderGoalContext(goal: SessionGoal, lessons: readonly GoalLesson[]): string {
	const durableLessons = lessons.map(({ kind, text }) => ({ kind, text }))
	const snapshot = JSON.stringify(
		{
			status: goal.status,
			objective: goal.objective,
			tokenBudget: goal.tokenBudget,
			...(durableLessons.length > 0 ? { lessons: durableLessons } : {}),
		},
		null,
		2,
	)
	const continuation =
		goal.status === "active"
			? "Autonomous goal continuation is enabled. The goal JSON above is authoritative. " +
				"Do not call get_goal while this context is present. " +
				"Use the separately supplied Todo state as the authoritative tactical plan; do not clear it while this goal is active. " +
				"Add a todo when you discover work the objective requires; a list that grows from real discovered work is progress, not a failure, even though it defers completion. " +
				"Keep activeForm as the exact current action and note as concise evidence or decisions that must survive compaction. " +
				"Prefix durable notes with Decision:, Evidence:, or Dead-end:; terminal notes may remain under lessons after their todos leave the list. " +
				"Do not repeat dead ends without new evidence. " +
				"Before completion, settle every todo, map every explicit goal requirement to concrete current evidence, and treat missing or uncertain evidence as incomplete. " +
				"Call update_goal only after receiving the final todo result that settles the list, as the only tool call in that response."
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
