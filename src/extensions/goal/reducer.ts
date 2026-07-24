import { GOAL_STATUSES, type GoalJournalEntry, type GoalStatus, type SessionGoal } from "./types.js"

export type GoalState = SessionGoal | undefined

function normalizeObjective(value: unknown): string {
	const objective = typeof value === "string" ? value.trim() : ""
	if (!objective) throw new Error("Goal objective cannot be empty.")
	return objective
}

export function createGoal(
	state: GoalState,
	objective: unknown,
	id: string,
	now: string,
	tokenBudget?: number,
): SessionGoal {
	if (state) throw new Error("A goal already exists.")
	return newGoal(objective, id, now, tokenBudget)
}

export function replaceGoal(
	_state: GoalState,
	objective: unknown,
	id: string,
	now: string,
	tokenBudget?: number,
): SessionGoal {
	return newGoal(objective, id, now, tokenBudget)
}

export function editGoal(
	state: GoalState,
	expectedId: string,
	expectedRevision: number,
	objective: unknown,
	now: string,
): SessionGoal {
	const current = requireCurrentGoal(state, expectedId, expectedRevision)
	return {
		...current,
		revision: current.revision + 1,
		objective: normalizeObjective(objective),
		updatedAt: now,
	}
}

export function setGoalStatus(
	state: GoalState,
	expectedId: string,
	expectedRevision: number,
	status: GoalStatus,
	now: string,
): SessionGoal {
	const current = requireCurrentGoal(state, expectedId, expectedRevision)
	if (!GOAL_STATUSES.includes(status)) throw new Error(`Invalid goal status '${String(status)}'.`)
	return { ...current, status, updatedAt: now }
}

export function addGoalAccounting(
	state: GoalState,
	expectedId: string,
	tokensUsed: number,
	timeUsedMs: number,
	now: string,
): SessionGoal {
	if (!state) throw new Error("Goal accounting rejected: no current goal exists.")
	if (state.id !== expectedId) {
		throw new Error(`Goal accounting rejected: expected goal ${expectedId}, but the current goal is ${state.id}.`)
	}
	const nextTokensUsed = state.tokensUsed + nonNegativeInteger(tokensUsed, "token usage")
	return {
		...state,
		status:
			state.status === "active" && state.tokenBudget !== undefined && nextTokensUsed >= state.tokenBudget
				? "budget_limited"
				: state.status,
		tokensUsed: nextTokensUsed,
		timeUsedMs: state.timeUsedMs + nonNegativeInteger(timeUsedMs, "elapsed time"),
		updatedAt: now,
	}
}

export function clearGoal(state: GoalState, expectedId: string, expectedRevision: number): undefined {
	requireCurrentGoal(state, expectedId, expectedRevision)
	return undefined
}

export function restoreGoal(entries: readonly unknown[]): GoalState {
	let state: GoalState
	for (const value of entries) {
		const entry = parseGoalJournalEntry(value)
		if (!entry) continue
		if (entry.op === "put") {
			state = entry.goal
		} else if (state?.id === entry.goalId && state.revision === entry.revision) {
			state = undefined
		}
	}
	return state
}

export function putGoalEntry(goal: SessionGoal): GoalJournalEntry {
	return { schemaVersion: 1, op: "put", goal }
}

export function clearGoalEntry(goal: SessionGoal, clearedAt: string): GoalJournalEntry {
	return {
		schemaVersion: 1,
		op: "clear",
		goalId: goal.id,
		revision: goal.revision,
		clearedAt,
	}
}

export function requireCurrentGoal(state: GoalState, expectedId: string, expectedRevision: number): SessionGoal {
	if (!state) throw new Error("Goal update rejected: no current goal exists.")
	if (state.id !== expectedId || state.revision !== expectedRevision) {
		throw new Error(
			`Goal update rejected: expected goal ${expectedId} revision ${expectedRevision}, but the current goal is ${state.id} revision ${state.revision}. Read the current goal and continue against the latest objective.`,
		)
	}
	return state
}

function newGoal(objective: unknown, id: string, now: string, tokenBudget?: number): SessionGoal {
	if (!id.trim()) throw new Error("Goal ID cannot be empty.")
	if (tokenBudget !== undefined && !isPositiveInteger(tokenBudget)) {
		throw new Error("Goal token budget must be a positive integer.")
	}
	return {
		schemaVersion: 1,
		id,
		revision: 1,
		objective: normalizeObjective(objective),
		status: "active",
		tokensUsed: 0,
		...(tokenBudget === undefined ? {} : { tokenBudget }),
		timeUsedMs: 0,
		createdAt: now,
		updatedAt: now,
	}
}

function parseGoalJournalEntry(value: unknown): GoalJournalEntry | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1) return undefined
	if (value.op === "put") {
		const goal = parseGoal(value.goal)
		return goal ? { schemaVersion: 1, op: "put", goal } : undefined
	}
	if (
		value.op === "clear" &&
		isNonEmptyString(value.goalId) &&
		isRevision(value.revision) &&
		isNonEmptyString(value.clearedAt)
	) {
		return {
			schemaVersion: 1,
			op: "clear",
			goalId: value.goalId,
			revision: value.revision,
			clearedAt: value.clearedAt,
		}
	}
	return undefined
}

function parseGoal(value: unknown): SessionGoal | undefined {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		!isNonEmptyString(value.id) ||
		!isRevision(value.revision) ||
		!isNonEmptyString(value.objective) ||
		!GOAL_STATUSES.includes(value.status as GoalStatus) ||
		(value.tokensUsed !== undefined && !isNonNegativeInteger(value.tokensUsed)) ||
		(value.tokenBudget !== undefined && !isPositiveInteger(value.tokenBudget)) ||
		(value.timeUsedMs !== undefined && !isNonNegativeInteger(value.timeUsedMs)) ||
		!isNonEmptyString(value.createdAt) ||
		!isNonEmptyString(value.updatedAt)
	) {
		return undefined
	}
	return {
		schemaVersion: 1,
		id: value.id,
		revision: value.revision,
		objective: value.objective,
		status: value.status as GoalStatus,
		tokensUsed: value.tokensUsed ?? 0,
		...(value.tokenBudget === undefined ? {} : { tokenBudget: value.tokenBudget }),
		timeUsedMs: value.timeUsedMs ?? 0,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0
}

function isRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function nonNegativeInteger(value: number, label: string): number {
	if (!isNonNegativeInteger(value)) throw new Error(`Goal ${label} must be a non-negative integer.`)
	return value
}
