import {
	FERMENT_V2_COMPLETION_CONFIDENCES,
	FERMENT_V2_EVALUATION_VERDICTS,
	FERMENT_V2_STATUSES,
	type FermentV2Evaluation,
	type FermentV2JournalEntry,
	type FermentV2Presentation,
	type FermentV2Status,
	type SessionFermentV2,
} from "./types.js"

const MAX_BLOCKED_REASON_LENGTH = 1_000

export type FermentV2State = SessionFermentV2 | undefined

function normalizeObjective(value: unknown): string {
	const objective = typeof value === "string" ? value.trim() : ""
	if (!objective) throw new Error("Ferment V2 objective cannot be empty.")
	return objective
}

export function createFermentV2(
	state: FermentV2State,
	objective: unknown,
	id: string,
	now: string,
	tokenBudget?: number,
	presentation?: FermentV2Presentation,
): SessionFermentV2 {
	if (state) throw new Error("A Ferment V2 already exists.")
	return newFermentV2(objective, id, now, tokenBudget, presentation)
}

export function replaceFermentV2(
	objective: unknown,
	id: string,
	now: string,
	tokenBudget?: number,
	presentation?: FermentV2Presentation,
): SessionFermentV2 {
	return newFermentV2(objective, id, now, tokenBudget, presentation)
}

export function editFermentV2(
	state: FermentV2State,
	expectedId: string,
	expectedRevision: number,
	objective: unknown,
	now: string,
): SessionFermentV2 {
	const current = requireCurrentFermentV2(state, expectedId, expectedRevision)
	const { completionConfidence: _completionConfidence, lastEvaluation: _lastEvaluation, ...editable } = current
	return {
		...editable,
		revision: current.revision + 1,
		objective: normalizeObjective(objective),
		updatedAt: now,
	}
}

export function setFermentV2Status(
	state: FermentV2State,
	expectedId: string,
	expectedRevision: number,
	status: FermentV2Status,
	now: string,
	blockedReason?: unknown,
): SessionFermentV2 {
	const current = requireCurrentFermentV2(state, expectedId, expectedRevision)
	if (!FERMENT_V2_STATUSES.includes(status)) throw new Error(`Invalid Ferment V2 status '${String(status)}'.`)
	const next = {
		...current,
		status: status === "active" && isOverBudget(current.tokenBudget, current.tokensUsed) ? "budget_limited" : status,
		updatedAt: now,
	}
	if (next.status === "blocked") {
		return { ...next, blockedReason: normalizeBlockedReason(blockedReason ?? current.blockedReason) }
	}
	const { blockedReason: _blockedReason, ...withoutBlockedReason } = next
	return withoutBlockedReason
}

export function addFermentV2Accounting(
	state: FermentV2State,
	expectedId: string,
	tokensUsed: number,
	timeUsedMs: number,
	now: string,
): SessionFermentV2 {
	if (!state) throw new Error("Ferment V2 accounting rejected: no current Ferment V2 exists.")
	if (state.id !== expectedId) {
		throw new Error(
			`Ferment V2 accounting rejected: expected Ferment V2 ${expectedId}, but the current Ferment V2 is ${state.id}.`,
		)
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

export function recordFermentV2Evaluation(
	state: FermentV2State,
	expectedId: string,
	expectedRevision: number,
	evaluation: FermentV2Evaluation,
	now: string,
): SessionFermentV2 {
	const current = requireCurrentFermentV2(state, expectedId, expectedRevision)
	return {
		...current,
		evaluationCount: (current.evaluationCount ?? 0) + 1,
		lastEvaluation: evaluation,
		updatedAt: now,
	}
}

export function setFermentV2ConsecutiveErrorTurns(
	state: FermentV2State,
	expectedId: string,
	expectedRevision: number,
	count: number,
	now: string,
): SessionFermentV2 {
	const current = requireCurrentFermentV2(state, expectedId, expectedRevision)
	return withCounterField(current, "consecutiveErrorTurns", count, now)
}

export function setFermentV2UnchangedContinuationTurns(
	state: FermentV2State,
	expectedId: string,
	expectedRevision: number,
	count: number,
	now: string,
): SessionFermentV2 {
	const current = requireCurrentFermentV2(state, expectedId, expectedRevision)
	return withCounterField(current, "unchangedContinuationTurns", count, now)
}

function withCounterField(
	fermentV2: SessionFermentV2,
	field: "consecutiveErrorTurns" | "unchangedContinuationTurns",
	count: number,
	now: string,
): SessionFermentV2 {
	const next = nonNegativeInteger(
		count,
		field === "consecutiveErrorTurns" ? "consecutive error turns" : "unchanged continuation turns",
	)
	if ((fermentV2[field] ?? 0) === next) return fermentV2
	const { [field]: _drop, ...rest } = fermentV2
	return next === 0 ? { ...rest, updatedAt: now } : { ...rest, [field]: next, updatedAt: now }
}

export function clearFermentV2(state: FermentV2State, expectedId: string, expectedRevision: number): undefined {
	requireCurrentFermentV2(state, expectedId, expectedRevision)
	return undefined
}

export function restoreFermentV2(entries: readonly unknown[], initialState?: FermentV2State): FermentV2State {
	let state = initialState
	for (const value of entries) {
		const entry = parseFermentV2JournalEntry(value)
		if (!entry) continue
		if (entry.op === "put") {
			state = entry.fermentV2
		} else if (entry.op === "clear" && state?.id === entry.fermentV2Id && state.revision === entry.revision) {
			state = undefined
		}
	}
	return state
}

export function putFermentV2Entry(fermentV2: SessionFermentV2): FermentV2JournalEntry {
	return { schemaVersion: 1, op: "put", fermentV2 }
}

export function clearFermentV2Entry(fermentV2: SessionFermentV2, clearedAt: string): FermentV2JournalEntry {
	return {
		schemaVersion: 1,
		op: "clear",
		fermentV2Id: fermentV2.id,
		revision: fermentV2.revision,
		clearedAt,
	}
}

function isOverBudget(tokenBudget: number | undefined, tokensUsed: number): boolean {
	return tokenBudget !== undefined && tokensUsed >= tokenBudget
}

function requireCurrentFermentV2(
	state: FermentV2State,
	expectedId: string,
	expectedRevision: number,
): SessionFermentV2 {
	if (!state) throw new Error("Ferment V2 update rejected: no current Ferment V2 exists.")
	if (state.id !== expectedId || state.revision !== expectedRevision) {
		throw new Error(
			`Ferment V2 update rejected: expected Ferment V2 ${expectedId} revision ${expectedRevision}, but the current Ferment V2 is ${state.id} revision ${state.revision}. Read the current Ferment V2 and continue against the latest objective.`,
		)
	}
	return state
}

function newFermentV2(
	objective: unknown,
	id: string,
	now: string,
	tokenBudget?: number,
	presentation?: FermentV2Presentation,
): SessionFermentV2 {
	if (!id.trim()) throw new Error("Ferment V2 ID cannot be empty.")
	if (tokenBudget !== undefined && !isPositiveInteger(tokenBudget)) {
		throw new Error("Ferment V2 token budget must be a positive integer.")
	}
	return {
		schemaVersion: 1,
		id,
		revision: 1,
		objective: normalizeObjective(objective),
		status: "active",
		tokensUsed: 0,
		...(presentation ? { presentation } : {}),
		...(tokenBudget === undefined ? {} : { tokenBudget }),
		timeUsedMs: 0,
		createdAt: now,
		updatedAt: now,
	}
}

function parseFermentV2JournalEntry(value: unknown): FermentV2JournalEntry | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1) return undefined
	if (value.op === "put") {
		const fermentV2 = parseFermentV2(value.fermentV2)
		return fermentV2 ? { schemaVersion: 1, op: "put", fermentV2 } : undefined
	}
	if (
		value.op === "clear" &&
		isNonEmptyString(value.fermentV2Id) &&
		isPositiveInteger(value.revision) &&
		isNonEmptyString(value.clearedAt)
	) {
		return {
			schemaVersion: 1,
			op: "clear",
			fermentV2Id: value.fermentV2Id,
			revision: value.revision,
			clearedAt: value.clearedAt,
		}
	}
	return undefined
}

function parseFermentV2(value: unknown): SessionFermentV2 | undefined {
	if (!isRecord(value)) return undefined
	const status = FERMENT_V2_STATUSES.find((candidate) => candidate === value.status)
	const completionConfidence = FERMENT_V2_COMPLETION_CONFIDENCES.find(
		(candidate) => candidate === value.completionConfidence,
	)
	const lastEvaluation = parseFermentV2Evaluation(value.lastEvaluation)
	const presentation = parseFermentV2Presentation(value.presentation)
	if (
		value.schemaVersion !== 1 ||
		!isNonEmptyString(value.id) ||
		!isPositiveInteger(value.revision) ||
		!isNonEmptyString(value.objective) ||
		status === undefined ||
		(value.blockedReason !== undefined && !isNonEmptyString(value.blockedReason)) ||
		(value.presentation !== undefined && presentation === undefined) ||
		(value.completionConfidence !== undefined && completionConfidence === undefined) ||
		(value.evaluationCount !== undefined && !isNonNegativeInteger(value.evaluationCount)) ||
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
		...(presentation ? { presentation } : {}),
		...(status === "blocked" && value.blockedReason !== undefined
			? { blockedReason: normalizeBlockedReason(value.blockedReason) }
			: {}),
		...(completionConfidence && status === "complete" ? { completionConfidence } : {}),
		...(value.evaluationCount === undefined ? {} : { evaluationCount: value.evaluationCount }),
		...(lastEvaluation ? { lastEvaluation } : {}),
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

function parseFermentV2Presentation(value: unknown): FermentV2Presentation | undefined {
	if (value === undefined) return undefined
	if (!isRecord(value) || value.kind !== "approved-plan" || !isNonEmptyString(value.title)) return undefined
	if (value.planPath !== undefined && !isNonEmptyString(value.planPath)) return undefined
	if (value.planText !== undefined && !isNonEmptyString(value.planText)) return undefined
	return {
		kind: "approved-plan",
		title: value.title,
		...(value.planPath === undefined ? {} : { planPath: value.planPath }),
		...(value.planText === undefined ? {} : { planText: value.planText }),
	}
}

function normalizeBlockedReason(value: unknown): string {
	const reason = typeof value === "string" ? value.trim() : ""
	return (reason || "Ferment V2 marked blocked.").slice(0, MAX_BLOCKED_REASON_LENGTH)
}

function parseFermentV2Evaluation(value: unknown): FermentV2Evaluation | undefined {
	if (!isRecord(value)) return undefined
	const verdict = FERMENT_V2_EVALUATION_VERDICTS.find((candidate) => candidate === value.verdict)
	if (!verdict || !isNonEmptyString(value.reason) || !isNonEmptyString(value.evaluatedAt)) return undefined
	if (value.model !== undefined && !isNonEmptyString(value.model)) return undefined
	return {
		verdict,
		reason: value.reason,
		...(typeof value.model === "string" ? { model: value.model } : {}),
		evaluatedAt: value.evaluatedAt,
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function nonNegativeInteger(value: number, label: string): number {
	if (!isNonNegativeInteger(value)) throw new Error(`Ferment V2 ${label} must be a non-negative integer.`)
	return value
}
