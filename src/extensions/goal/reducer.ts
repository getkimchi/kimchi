import {
	GOAL_COMPLETION_CONFIDENCES,
	GOAL_EVALUATION_VERDICTS,
	GOAL_STATUSES,
	type GoalEvaluation,
	type GoalJournalEntry,
	type GoalStatus,
	type SessionGoal,
} from "./types.js"

export type GoalState = SessionGoal | undefined

function normalizeObjective(value: unknown): string {
	const objective = typeof value === "string" ? value.trim() : ""
	if (!objective) throw new Error("Goal objective cannot be empty.")
	if (objective.length > 4_000) throw new Error("Goal objective cannot exceed 4,000 characters.")
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

export function replaceGoal(objective: unknown, id: string, now: string, tokenBudget?: number): SessionGoal {
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
	return {
		...current,
		status: status === "active" && isOverBudget(current.tokenBudget, current.tokensUsed) ? "budget_limited" : status,
		updatedAt: now,
	}
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
			state.status === "active" && isOverBudget(state.tokenBudget, nextTokensUsed) ? "budget_limited" : state.status,
		tokensUsed: nextTokensUsed,
		timeUsedMs: state.timeUsedMs + nonNegativeInteger(timeUsedMs, "elapsed time"),
		updatedAt: now,
	}
}

export function recordGoalEvaluation(
	state: GoalState,
	expectedId: string,
	expectedRevision: number,
	evaluation: GoalEvaluation,
	usage: SessionGoal["evaluatorUsage"],
	now: string,
): SessionGoal {
	const current = requireCurrentGoal(state, expectedId, expectedRevision)
	return {
		...current,
		evaluationCount: (current.evaluationCount ?? 0) + 1,
		lastEvaluation: evaluation,
		...(usage ? { evaluatorUsage: addUsage(current.evaluatorUsage, usage) } : {}),
		updatedAt: now,
	}
}

/**
 * Sets the persisted consecutive-agent-error-turn streak that backs
 * getGoalSettings().maxConsecutiveErrors (settings.ts), omitting the field
 * once the streak is back to zero. Returns the same object when the count
 * already matches, mirroring addGoalAccounting's no-op-on-no-change shape so
 * callers can tell whether a commit is actually needed by reference
 * equality.
 */
export function setGoalConsecutiveErrorTurns(
	state: GoalState,
	expectedId: string,
	expectedRevision: number,
	count: number,
	now: string,
): SessionGoal {
	const current = requireCurrentGoal(state, expectedId, expectedRevision)
	return withCounterField(current, "consecutiveErrorTurns", count, now)
}

/**
 * Sets the persisted no-progress continuation streak that backs
 * getGoalSettings().maxUnchangedContinuations (settings.ts). Same shape as
 * setGoalConsecutiveErrorTurns.
 */
export function setGoalUnchangedContinuationTurns(
	state: GoalState,
	expectedId: string,
	expectedRevision: number,
	count: number,
	now: string,
): SessionGoal {
	const current = requireCurrentGoal(state, expectedId, expectedRevision)
	return withCounterField(current, "unchangedContinuationTurns", count, now)
}

function withCounterField(
	goal: SessionGoal,
	field: "consecutiveErrorTurns" | "unchangedContinuationTurns",
	count: number,
	now: string,
): SessionGoal {
	const next = nonNegativeInteger(
		count,
		field === "consecutiveErrorTurns" ? "consecutive error turns" : "unchanged continuation turns",
	)
	if ((goal[field] ?? 0) === next) return goal
	const { [field]: _drop, ...rest } = goal
	return next === 0 ? { ...rest, updatedAt: now } : { ...rest, [field]: next, updatedAt: now }
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

function isOverBudget(tokenBudget: number | undefined, tokensUsed: number): boolean {
	return tokenBudget !== undefined && tokensUsed >= tokenBudget
}

function requireCurrentGoal(state: GoalState, expectedId: string, expectedRevision: number): SessionGoal {
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
	if (!isRecord(value)) return undefined
	const status = GOAL_STATUSES.find((candidate) => candidate === value.status)
	const completionConfidence = GOAL_COMPLETION_CONFIDENCES.find((candidate) => candidate === value.completionConfidence)
	const lastEvaluation = parseGoalEvaluation(value.lastEvaluation)
	const evaluatorUsage = parseUsage(value.evaluatorUsage)
	if (
		value.schemaVersion !== 1 ||
		!isNonEmptyString(value.id) ||
		!isRevision(value.revision) ||
		!isNonEmptyString(value.objective) ||
		status === undefined ||
		(value.completionConfidence !== undefined && completionConfidence === undefined) ||
		// Evaluation fields are observability only: a malformed one is dropped
		// rather than rejecting the whole entry, which would silently roll the
		// restored goal back to an older revision.
		(value.evaluationCount !== undefined && !isNonNegativeInteger(value.evaluationCount)) ||
		// Unlike evaluationCount, these two gate a safety pause (limits are
		// getGoalSettings().maxConsecutiveErrors / maxUnchangedContinuations,
		// settings.ts): silently dropping a malformed value back to zero would
		// defeat the stall guard the same way the bug they exist to fix does,
		// so a malformed counter rejects the whole entry instead, falling back
		// to the last validly-persisted goal.
		(value.consecutiveErrorTurns !== undefined && !isNonNegativeInteger(value.consecutiveErrorTurns)) ||
		(value.unchangedContinuationTurns !== undefined && !isNonNegativeInteger(value.unchangedContinuationTurns)) ||
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
		status,
		...(completionConfidence && status === "complete" ? { completionConfidence } : {}),
		...(value.evaluationCount === undefined ? {} : { evaluationCount: value.evaluationCount }),
		...(lastEvaluation ? { lastEvaluation } : {}),
		...(evaluatorUsage ? { evaluatorUsage } : {}),
		...(value.consecutiveErrorTurns === undefined ? {} : { consecutiveErrorTurns: value.consecutiveErrorTurns }),
		...(value.unchangedContinuationTurns === undefined
			? {}
			: { unchangedContinuationTurns: value.unchangedContinuationTurns }),
		tokensUsed: value.tokensUsed ?? 0,
		...(value.tokenBudget === undefined ? {} : { tokenBudget: value.tokenBudget }),
		timeUsedMs: value.timeUsedMs ?? 0,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	}
}

function parseGoalEvaluation(value: unknown): GoalEvaluation | undefined {
	if (!isRecord(value)) return undefined
	const verdict = GOAL_EVALUATION_VERDICTS.find((candidate) => candidate === value.verdict)
	if (!verdict || !isNonEmptyString(value.reason) || !isNonEmptyString(value.evaluatedAt)) return undefined
	if (value.model !== undefined && !isNonEmptyString(value.model)) return undefined
	return {
		verdict,
		reason: value.reason,
		...(typeof value.model === "string" ? { model: value.model } : {}),
		evaluatedAt: value.evaluatedAt,
	}
}

function nonNegativeNumberField(value: unknown): number | undefined {
	return isNonNegativeNumber(value) ? value : undefined
}

function parseUsage(value: unknown): SessionGoal["evaluatorUsage"] {
	if (!isRecord(value)) return undefined
	const input = nonNegativeNumberField(value.input)
	const output = nonNegativeNumberField(value.output)
	const cacheRead = nonNegativeNumberField(value.cacheRead)
	const cacheWrite = nonNegativeNumberField(value.cacheWrite)
	const totalTokens = nonNegativeNumberField(value.totalTokens)
	const costUsd = nonNegativeNumberField(value.costUsd)
	if (
		input === undefined ||
		output === undefined ||
		cacheRead === undefined ||
		cacheWrite === undefined ||
		totalTokens === undefined ||
		costUsd === undefined
	) {
		return undefined
	}
	return { input, output, cacheRead, cacheWrite, totalTokens, costUsd }
}

export function addUsage(
	left: SessionGoal["evaluatorUsage"],
	right: NonNullable<SessionGoal["evaluatorUsage"]>,
): NonNullable<SessionGoal["evaluatorUsage"]> {
	if (!left) return right
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		costUsd: left.costUsd + right.costUsd,
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
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

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function nonNegativeInteger(value: number, label: string): number {
	if (!isNonNegativeInteger(value)) throw new Error(`Goal ${label} must be a non-negative integer.`)
	return value
}
