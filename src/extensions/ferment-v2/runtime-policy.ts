import type { TodoItem } from "../todos/types.js"
import type { FermentV2Lesson } from "./lessons.js"
import { isRecord } from "./reducer.js"
import type { PendingFermentV2Continuation, SessionFermentV2 } from "./types.js"

export type FermentV2TodoState = PendingFermentV2Continuation & {
	todos: readonly TodoItem[]
	total: number
	blocked: number
	completed: number
	settledStatus?: "complete" | "blocked"
}

export function matchesFermentV2(
	marker: PendingFermentV2Continuation | undefined,
	fermentV2: SessionFermentV2 | undefined,
	sessionId: string | undefined,
): boolean {
	return Boolean(
		marker &&
			fermentV2 &&
			marker.sessionId === sessionId &&
			marker.fermentV2Id === fermentV2.id &&
			marker.revision === fermentV2.revision,
	)
}

export function isSupersededFermentV2(
	marker: PendingFermentV2Continuation | undefined,
	fermentV2: SessionFermentV2 | undefined,
	sessionId: string | undefined,
): boolean {
	return Boolean(
		marker &&
			fermentV2 &&
			marker.sessionId === sessionId &&
			marker.fermentV2Id === fermentV2.id &&
			marker.revision < fermentV2.revision,
	)
}

export function isReadyForFinalAnswer(
	fermentV2: SessionFermentV2 | undefined,
	todoStateFor: FermentV2TodoState | undefined,
	sessionId: string | undefined,
	hasUI: boolean,
): boolean {
	const todoState = matchesFermentV2(todoStateFor, fermentV2, sessionId) ? todoStateFor : undefined
	return Boolean(
		fermentV2 &&
			(fermentV2.status === "active" || fermentV2.status === "paused") &&
			fermentV2.lastEvaluation?.verdict === "met" &&
			(!hasUI || (todoState?.total && todoState.settledStatus === "complete")),
	)
}

export function todoCounts(todos: readonly unknown[]): Pick<FermentV2TodoState, "total" | "blocked" | "completed"> {
	const counts = { total: todos.length, blocked: 0, completed: 0 }
	for (const todo of todos) {
		if (!isRecord(todo)) continue
		if (todo.status === "blocked") counts.blocked += 1
		else if (todo.status === "completed") counts.completed += 1
	}
	return counts
}

/**
 * A settled empty list carries no verdict of its own — an item that was just
 * cleared should not silently overwrite the previous settled status, so an
 * empty count keeps whatever the list last settled to.
 */
export function deriveSettledStatus(
	counts: Pick<FermentV2TodoState, "total" | "blocked" | "completed">,
	previousSettledStatus: FermentV2TodoState["settledStatus"],
): FermentV2TodoState["settledStatus"] {
	if (counts.total === 0) return previousSettledStatus
	if (counts.completed === counts.total) return "complete"
	if (counts.blocked > 0 && counts.completed + counts.blocked === counts.total) return "blocked"
	return undefined
}

export function rebindTodoState(state: FermentV2TodoState, fermentV2: SessionFermentV2): FermentV2TodoState {
	return {
		sessionId: state.sessionId,
		fermentV2Id: fermentV2.id,
		revision: fermentV2.revision,
		todos: state.todos,
		total: state.total,
		blocked: state.blocked,
		completed: state.completed,
	}
}

export function isStatusOnlyTodoSettlement(previous: readonly TodoItem[], next: readonly TodoItem[]): boolean {
	if (previous.length !== next.length) return false
	const previousById = new Map(previous.map((todo) => [todo.id, todo]))
	const seenIds = new Set<TodoItem["id"]>()
	for (const item of next) {
		if (seenIds.has(item.id)) return false
		seenIds.add(item.id)
		const before = previousById.get(item.id)
		if (!before) return false
		if (
			before.content !== item.content ||
			before.activeForm !== item.activeForm ||
			before.note !== item.note ||
			(item.status !== before.status && item.status !== "completed")
		) {
			return false
		}
	}
	return true
}

/**
 * Ignore pending-only additions; progress begins when an item starts or settles.
 * Canonicalize identity-keyed items so display-only reordering is not progress.
 */
export function fermentV2ProgressFingerprint(
	fermentV2: SessionFermentV2,
	todoState: FermentV2TodoState | undefined,
	lessons: readonly FermentV2Lesson[],
): string {
	const todos = todoState
		? [...todoState.todos]
				.filter((todo) => todo.status !== "pending")
				.sort((a, b) => a.id - b.id)
				.map(({ id, status, content, activeForm, note }) => [
					id,
					status,
					content,
					activeForm?.trim() ?? null,
					note?.trim() ?? null,
				])
		: []
	const durableLessons = [...lessons]
		.sort((a, b) => a.todoId - b.todoId)
		.map(({ todoId, kind, text }) => [todoId, kind, text])
	return JSON.stringify([fermentV2.id, fermentV2.revision, todos, durableLessons])
}

export function deriveContinuationDecision(input: {
	verdict: "continue" | "met"
	reason: string
	evaluated: SessionFermentV2
	previousEvaluation: SessionFermentV2["lastEvaluation"]
	todoState: FermentV2TodoState | undefined
	lessons: readonly FermentV2Lesson[]
	startFingerprint: string | undefined
	hadSubstantiveToolUse: boolean
}): { reason: string; unchanged: number } {
	const missingTodoForMet = input.verdict === "met" && !input.todoState?.total
	const reason = missingTodoForMet
		? 'Create a visible Todo list now, mark verified work completed, and record concrete "Evidence: ..." notes before finishing.'
		: input.verdict === "met"
			? "Keep a visible, fully completed Todo list before finishing."
			: input.reason
	const fingerprint = fermentV2ProgressFingerprint(input.evaluated, input.todoState, input.lessons)
	const repeatedGap =
		input.verdict === "continue" &&
		input.previousEvaluation?.verdict === "continue" &&
		input.previousEvaluation.reason === input.reason &&
		fingerprint === input.startFingerprint
	const unchanged =
		(missingTodoForMet && fingerprint === input.startFingerprint) ||
		repeatedGap ||
		(!input.hadSubstantiveToolUse && fingerprint === input.startFingerprint)
			? (input.evaluated.unchangedContinuationTurns ?? 0) + 1
			: 0
	return { reason, unchanged }
}
