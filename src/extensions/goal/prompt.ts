import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import type { TodoItem } from "../todos/types.js"
import { GOAL_CONTEXT_MESSAGE_TYPE } from "./constants.js"
import type { GoalLesson } from "./lessons.js"
import type { SessionGoal } from "./types.js"

export function replaceGoalContextMessages(
	messages: ContextEvent["messages"],
	goal: SessionGoal | undefined,
	todos: readonly TodoItem[] = [],
	lessons: readonly GoalLesson[] = [],
): ContextEvent["messages"] | undefined {
	const filtered = messages.filter((message) => !isGoalContextMessage(message))
	if (!goal) return filtered.length === messages.length ? undefined : filtered

	const message = {
		role: "custom" as const,
		customType: GOAL_CONTEXT_MESSAGE_TYPE,
		content: [{ type: "text" as const, text: renderGoalContext(goal, todos, lessons) }],
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

export function buildGoalContinuation(needsProgressUpdate = false): string {
	const progress = needsProgressUpdate
		? " No todo progress was recorded in the previous continuation; update the current item's status, activeForm, or note with the next action or evidence."
		: ""
	return `Continue the active goal using the canonical goal and todo snapshot. Make concrete progress, keep the todo list current, and settle every item before update_goal.${progress}`
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

function renderGoalContext(goal: SessionGoal, todos: readonly TodoItem[], lessons: readonly GoalLesson[]): string {
	const visibleTodoIds = new Set(todos.map(({ id }) => id))
	const archivedLessons = lessons
		.filter(({ todoId }) => !visibleTodoIds.has(todoId))
		.map(({ kind, text }) => ({ kind, text }))
	const snapshot = JSON.stringify(
		{
			status: goal.status,
			objective: goal.objective,
			tokenBudget: goal.tokenBudget,
			...(archivedLessons.length > 0 ? { lessons: archivedLessons } : {}),
			todos: todos.map(({ id, content, status, activeForm, note }) => ({
				id,
				content,
				status,
				...(activeForm ? { activeForm } : {}),
				...(note ? { note } : {}),
			})),
		},
		null,
		2,
	)
	const continuation =
		goal.status === "active"
			? "Autonomous goal continuation is enabled. The goal JSON above is authoritative. " +
				"Do not call get_goal while this context is present. " +
				"Track work with a visible tactical todo list. " +
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
