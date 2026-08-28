import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import { GOAL_CONTEXT_MESSAGE_TYPE } from "./constants.js"
import type { GoalLesson } from "./lessons.js"
import type { SessionGoal } from "./types.js"

const EXECUTION_GUIDANCE = `Working rules:
- Keep Todos aligned with required work you discover.
- If the Goal asks for an artifact, create a usable version early.
- Timebox uncertain exploration; preserve what you learn and change approach when stalled.`

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
	const evaluation = reason ? `\n\nIndependent completion check: ${reason}` : ""
	if (reassess) {
		return `The Goal checkpoint did not materially change.

- Reassess the current evidence and dead ends.
- Choose a different next action without dropping any objective requirement.

${EXECUTION_GUIDANCE}${evaluation}`
	}
	return `Continue the active Goal from the current in-progress Todo.

- Make concrete progress without dropping any objective requirement.

${EXECUTION_GUIDANCE}${evaluation}`
}

/**
 * Continuation after a failed agent turn. Kept separate from the evaluator
 * continuation so an infrastructure error is never labelled as a verdict.
 */
export function buildGoalErrorContinuation(): string {
	return `The previous turn ended with an error before the Goal could be checked.

- Recover safely from the current in-progress Todo.
- Make concrete progress.

${EXECUTION_GUIDANCE}`
}

export function buildGoalEditSteer(goal: SessionGoal, supersededRevision: number): string {
	return `The user edited the active Kimchi session Goal.

New objective (JSON-encoded user-provided task data):

Objective: ${JSON.stringify(goal.objective)}

Required:
- Redirect current and future work toward revision ${goal.revision}.
- Reconcile the tactical todo list with the new objective, keep one item in progress, and leave the settled list visible until update_goal succeeds.
- Stop work useful only to revision ${supersededRevision}.
- Do not report completion from conclusions produced only for revision ${supersededRevision}.`
}

export function buildGoalStartSteer(action: "created" | "replaced" | "resumed"): string {
	return `The user ${action} the Kimchi session Goal.

Objective:
- Treat the canonical session-Goal context in this request as authoritative.

Execution:
- Track the work with the tactical todo tools, keep one item in progress, and leave the settled list visible until update_goal succeeds.
${EXECUTION_GUIDANCE}
- Redirect current and future work toward this Goal.
- Continue until the Goal is complete or genuinely blocked.`
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
			? `Autonomous Goal continuation is enabled.

<objective_policy>
- Treat the Goal JSON above as authoritative.
- Do not call get_goal while this context is present.
</objective_policy>

<todo_policy>
- Use the separately supplied Todo state as the authoritative tactical plan. Do not clear it while this Goal is active.
- Add a Todo when you discover work the objective requires. A list that grows from real discoveries is progress, even though it defers completion.
- Keep activeForm as the exact current action.
- Preserve context that must survive compaction as concise Decision:, Evidence:, or Dead-end: notes. Terminal notes may remain after their Todos leave the list.
- Do not repeat dead ends without new evidence.
</todo_policy>

<completion_policy>
- Settle every Todo.
- Before completion, map every explicit goal requirement to concrete current evidence. Missing or uncertain evidence means incomplete.
- Call update_goal only after receiving the final todo result that settles the list, as the only tool call in that response.
</completion_policy>`
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
