import { deriveFermentV2Name } from "./name.js"
import {
	FERMENT_V2_MAX_REQUIREMENTS,
	isFermentV2ObjectiveDigest,
	nextRequirementIdWatermark,
	parseVerifierRequirements,
	type RequirementAddition,
	sameRequirementItem as sharedSameRequirementItem,
	type VerifierRequirement,
} from "./requirements.js"
import {
	FERMENT_V2_COMPLETION_CONFIDENCES,
	FERMENT_V2_EVALUATION_VERDICTS,
	FERMENT_V2_REQUIREMENTS_AVAILABILITY,
	FERMENT_V2_REQUIREMENTS_PROVENANCE,
	FERMENT_V2_STATUSES,
	type FermentV2Baseline,
	type FermentV2Evaluation,
	type FermentV2EvaluatorUsage,
	type FermentV2JournalEntry,
	type FermentV2Presentation,
	type FermentV2Requirements,
	type FermentV2RequirementsProvenance,
	type FermentV2RequirementsRevision,
	type FermentV2Status,
	type FermentV2VerifierUsage,
	type SessionFermentV2,
} from "./types.js"

const MAX_BLOCKED_REASON_LENGTH = 1_000

export type FermentV2State = SessionFermentV2 | undefined

function normalizeObjective(value: unknown): string {
	const objective = typeof value === "string" ? value.trim() : ""
	if (!objective) throw new Error("Ferment V2 objective cannot be empty.")
	return objective
}

/**
 * Build the pending requirements record a goal starts with (and a legacy goal
 * bootstraps at its next safe checkpoint). The contract targets the exact
 * resolved objective text passed here — later edits to an objective file
 * cannot silently rewrite it.
 */
export function createPendingFermentV2Requirements(input: {
	objectiveRevision: number
	objectiveText: string
	objectiveDigest: string
	baselineCommit?: string
	provenance: FermentV2RequirementsProvenance
}): FermentV2Requirements {
	if (!isPositiveInteger(input.objectiveRevision)) {
		throw new Error("Ferment V2 requirements objective revision must be a positive integer.")
	}
	if (!normalizeObjective(input.objectiveText))
		throw new Error("Ferment V2 requirements objective text cannot be empty.")
	if (!isFermentV2ObjectiveDigest(input.objectiveDigest)) {
		throw new Error("Ferment V2 requirements objective digest must be a hex sha256 digest.")
	}
	return {
		schemaVersion: 1,
		contractVersion: 0,
		objectiveRevision: input.objectiveRevision,
		objectiveDigest: input.objectiveDigest,
		objectiveText: input.objectiveText,
		...(input.baselineCommit ? { baselineCommit: input.baselineCommit } : {}),
		provenance: input.provenance,
		availability: "pending",
		items: [],
		idWatermark: 0,
		history: [],
	}
}

export function createFermentV2(
	state: FermentV2State,
	objective: unknown,
	id: string,
	now: string,
	tokenBudget?: number,
	presentation?: FermentV2Presentation,
	baseline?: FermentV2Baseline,
	requirements?: FermentV2Requirements,
): SessionFermentV2 {
	if (state) throw new Error("A Ferment V2 already exists.")
	return newFermentV2(objective, id, now, tokenBudget, presentation, baseline, requirements)
}

export function replaceFermentV2(
	objective: unknown,
	id: string,
	now: string,
	tokenBudget?: number,
	presentation?: FermentV2Presentation,
	baseline?: FermentV2Baseline,
	requirements?: FermentV2Requirements,
): SessionFermentV2 {
	return newFermentV2(objective, id, now, tokenBudget, presentation, baseline, requirements)
}

export function editFermentV2(
	state: FermentV2State,
	expectedId: string,
	expectedRevision: number,
	objective: unknown,
	now: string,
): SessionFermentV2 {
	const current = requireCurrentFermentV2(state, expectedId, expectedRevision)
	const {
		completionConfidence: _completionConfidence,
		lastEvaluation: _lastEvaluation,
		presentation: _presentation,
		...editable
	} = current
	const nextObjective = normalizeObjective(objective)
	return {
		...editable,
		revision: current.revision + 1,
		objective: nextObjective,
		name: deriveFermentV2Name(nextObjective),
		status: current.status === "complete" ? "paused" : current.status,
		// The previous criteria are invalidated for verification (their objective
		// revision now lags) but their accepted history is retained; a refreshed
		// draft gets a fresh retry budget.
		...(current.requirements ? { requirements: invalidateFermentV2Requirements(current.requirements) } : {}),
		updatedAt: now,
	}
}

/** Reset a record to pending for a new objective generation, omitting the volatile fields. */
function invalidateFermentV2Requirements(record: FermentV2Requirements): FermentV2Requirements {
	const { draftRetried: _draftRetried, unavailableReason: _unavailableReason, ...rest } = record
	return { ...rest, availability: "pending" }
}

/** Fold one requirements-draft run's usage into the ferment's cumulative stage accounting. */
export function recordFermentV2RequirementsUsage(
	state: FermentV2State,
	expectedId: string,
	usage: FermentV2EvaluatorUsage,
	now: string,
): SessionFermentV2 {
	if (!state) throw new Error("Ferment V2 requirements accounting rejected: no current Ferment V2 exists.")
	if (state.id !== expectedId) {
		throw new Error(
			`Ferment V2 requirements accounting rejected: expected Ferment V2 ${expectedId}, but the current Ferment V2 is ${state.id}.`,
		)
	}
	const previous = state.requirementsUsage
	return {
		...state,
		requirementsUsage: {
			runs: (previous?.runs ?? 0) + 1,
			input: (previous?.input ?? 0) + usage.input,
			output: (previous?.output ?? 0) + usage.output,
			cacheRead: (previous?.cacheRead ?? 0) + usage.cacheRead,
			cacheWrite: (previous?.cacheWrite ?? 0) + usage.cacheWrite,
			totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens,
			costUsd: (previous?.costUsd ?? 0) + usage.costUsd,
		},
		updatedAt: now,
	}
}

/** Mark that the one degraded-outage retry at a completion claim has been spent. Idempotent. */
export function markFermentV2RequirementsRetried(
	state: FermentV2State,
	expectedId: string,
	expectedRevision: number,
	now: string,
): SessionFermentV2 {
	const current = requireCurrentFermentV2(state, expectedId, expectedRevision)
	if (!current.requirements || current.requirements.draftRetried) return current
	return {
		...current,
		requirements: { ...current.requirements, draftRetried: true },
		updatedAt: now,
	}
}

export interface FermentV2RequirementsApplication {
	objectiveRevision: number
	objectiveDigest: string
	provenance: FermentV2RequirementsProvenance
	availability: "ready" | "unavailable"
	/** The accepted list when availability is `ready`. */
	items?: readonly VerifierRequirement[]
	unavailableReason?: string
	actor?: string
	reason?: string
}

/**
 * Apply a settled draft result to the pending requirements record, fenced by
 * the ferment identity, the contract version the caller captured, and the
 * objective digest the record targets. A ready result accepts the complete
 * list (validated, fresh IDs only, watermark advanced, history appended,
 * contract version bumped); an unavailable result records the degraded state
 * without touching history. An identical ready list on an already ready
 * record is an idempotent no-op; a different list never overwrites a newer
 * one — the caller treats the throw as a stale fence.
 */
export function applyFermentV2Requirements(
	state: FermentV2State,
	expectedId: string,
	expectedRevision: number,
	expectedContractVersion: number,
	application: FermentV2RequirementsApplication,
	now: string,
): SessionFermentV2 {
	const current = requireCurrentFermentV2(state, expectedId, expectedRevision)
	const record = current.requirements
	if (!record) throw new Error("Ferment V2 requirements rejected: no requirements record exists.")
	if (record.contractVersion !== expectedContractVersion) {
		throw new Error(
			`Ferment V2 requirements rejected: expected contract version ${expectedContractVersion}, but the current contract version is ${record.contractVersion}. The draft result is stale.`,
		)
	}
	if (record.objectiveDigest !== application.objectiveDigest) {
		throw new Error("Ferment V2 requirements rejected: the draft result targets a different objective.")
	}
	if (application.availability === "unavailable") {
		if (record.availability === "unavailable") return current
		if (record.availability !== "pending") {
			throw new Error("Ferment V2 requirements rejected: the record already settled with a contract.")
		}
		const reason = application.unavailableReason?.trim() || "Requirements drafting failed."
		return {
			...current,
			requirements: {
				...record,
				provenance: application.provenance,
				availability: "unavailable",
				unavailableReason: reason.slice(0, MAX_BLOCKED_REASON_LENGTH),
			},
			updatedAt: now,
		}
	}
	const items = parseVerifierRequirements(application.items)
	if (!items) {
		throw new Error(
			"Ferment V2 requirements rejected: the drafted list must contain 1–64 items with distinct IDs and nonempty requirement, source, acceptance, and a valid category.",
		)
	}
	if (application.objectiveRevision !== record.objectiveRevision) {
		throw new Error("Ferment V2 requirements rejected: the draft result targets a different objective revision.")
	}
	// An identical list on an already ready record is an idempotent no-op.
	if (record.availability === "ready" && sameRequirementItems(record.items, items)) return current
	if (record.availability === "ready") {
		throw new Error(
			"Ferment V2 requirements rejected: the current contract is already ready; a redraft cannot replace it.",
		)
	}
	const watermark = nextRequirementIdWatermark(
		record.idWatermark,
		items,
		record.items.length ? record.items : (record.history.at(-1)?.items ?? []),
	)
	const version = record.contractVersion + 1
	const { unavailableReason: _drop, ...recordWithoutReason } = record
	return {
		...current,
		requirements: {
			...recordWithoutReason,
			contractVersion: version,
			provenance: application.provenance,
			availability: "ready",
			items,
			idWatermark: watermark,
			history: [
				...record.history,
				{
					version,
					items,
					actor: application.actor?.trim() || "requirements_draft",
					...(application.reason?.trim() ? { reason: application.reason.trim() } : {}),
					objectiveRevision: application.objectiveRevision,
					acceptedAt: now,
				},
			],
		},
		updatedAt: now,
	}
}

function sameRequirementItems(a: readonly VerifierRequirement[], b: readonly VerifierRequirement[]): boolean {
	return (
		a.length === b.length && a.every((item, index) => b[index] !== undefined && sameRequirementItem(item, b[index]))
	)
}

/**
 * Apply the additions a final review accepted, atomically and fenced by the
 * ferment identity, the ferment revision (an objective edit bumps it), and
 * the contract version the review started from. Each addition must be based
 * on the running version the review itself advanced (the first on the
 * persisted version, each later one on the version the previous acceptance
 * produced), so the review's own accepted version advances never invalidate
 * it — while a competing external update or a newer review (a moved contract
 * version) rejects the whole application without overwriting newer state.
 * Every accepted addition appends one immutable history entry (items, reason,
 * actor, version, objective revision, timestamp), advances the ID watermark
 * past every allocated ID (retired IDs are never reused), and never touches
 * an existing item: an addition colliding with a current ID is rejected.
 */
export function applyFermentV2RequirementsAdditions(
	state: FermentV2State,
	expectedId: string,
	expectedRevision: number,
	expectedContractVersion: number,
	additions: readonly RequirementAddition[],
	now: string,
	actor = "final_review",
): SessionFermentV2 {
	const current = requireCurrentFermentV2(state, expectedId, expectedRevision)
	const record = current.requirements
	if (!record) throw new Error("Ferment V2 requirements additions rejected: no requirements record exists.")
	if (record.availability !== "ready") {
		throw new Error("Ferment V2 requirements additions rejected: the requirements contract is not ready.")
	}
	if (record.contractVersion !== expectedContractVersion) {
		throw new Error(
			`Ferment V2 requirements additions rejected: expected contract version ${expectedContractVersion}, but the current contract version is ${record.contractVersion}. The review result is stale.`,
		)
	}
	if (additions.length === 0) return current
	let version = record.contractVersion
	let watermark = record.idWatermark
	const combined: VerifierRequirement[] = [...record.items]
	const entries: FermentV2RequirementsRevision[] = []
	for (const addition of additions) {
		const items = parseVerifierRequirements(addition.items)
		if (!items) {
			throw new Error(
				"Ferment V2 requirements additions rejected: each addition needs 1–64 items with distinct IDs and nonempty requirement, source, acceptance, and a valid category.",
			)
		}
		const reason = typeof addition.reason === "string" ? addition.reason.trim() : ""
		if (!reason) {
			throw new Error("Ferment V2 requirements additions rejected: each addition needs a source-grounded reason.")
		}
		if (addition.basedOnVersion !== version) {
			throw new Error(
				`Ferment V2 requirements additions rejected: an addition is based on version ${addition.basedOnVersion}, but the review's contract is at version ${version}.`,
			)
		}
		if (combined.length + items.length > FERMENT_V2_MAX_REQUIREMENTS) {
			throw new Error(
				`Ferment V2 requirements additions rejected: the contract cannot exceed ${FERMENT_V2_MAX_REQUIREMENTS} items.`,
			)
		}
		const currentIds = new Set(combined.map((item) => item.id))
		if (items.some((item) => currentIds.has(item.id))) {
			throw new Error(
				"Ferment V2 requirements additions rejected: an addition cannot replace an existing criterion; additions must use fresh IDs.",
			)
		}
		watermark = nextRequirementIdWatermark(watermark, items, combined)
		version += 1
		combined.push(...items)
		entries.push({
			version,
			items: [...combined],
			actor,
			reason,
			objectiveRevision: record.objectiveRevision,
			acceptedAt: now,
		})
	}
	return {
		...current,
		requirements: {
			...record,
			contractVersion: version,
			items: [...combined],
			idWatermark: watermark,
			history: [...record.history, ...entries],
		},
		updatedAt: now,
	}
}

function sameRequirementItem(a: VerifierRequirement, b: VerifierRequirement | undefined): boolean {
	return b !== undefined && sharedSameRequirementItem(a, b)
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

/** Fold one executing-verifier run's usage into the ferment's cumulative verifier accounting. */
export function recordFermentV2VerifierUsage(
	state: FermentV2State,
	expectedId: string,
	usage: FermentV2EvaluatorUsage,
	now: string,
): SessionFermentV2 {
	if (!state) throw new Error("Ferment V2 verifier accounting rejected: no current Ferment V2 exists.")
	if (state.id !== expectedId) {
		throw new Error(
			`Ferment V2 verifier accounting rejected: expected Ferment V2 ${expectedId}, but the current Ferment V2 is ${state.id}.`,
		)
	}
	const previous = state.verifierUsage
	return {
		...state,
		verifierUsage: {
			runs: (previous?.runs ?? 0) + 1,
			input: (previous?.input ?? 0) + usage.input,
			output: (previous?.output ?? 0) + usage.output,
			cacheRead: (previous?.cacheRead ?? 0) + usage.cacheRead,
			cacheWrite: (previous?.cacheWrite ?? 0) + usage.cacheWrite,
			totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens,
			costUsd: (previous?.costUsd ?? 0) + usage.costUsd,
		},
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

/**
 * Persist that the user has been warned about the evaluator running on the
 * implementer's model. Idempotent: the flag is never cleared once set, so the
 * warning fires at most once per ferment (also across resume/replay).
 */
export function markFermentV2EvaluatorModelWarned(
	state: FermentV2State,
	expectedId: string,
	expectedRevision: number,
	now: string,
): SessionFermentV2 {
	const current = requireCurrentFermentV2(state, expectedId, expectedRevision)
	if (current.evaluatorModelWarned) return current
	return { ...current, evaluatorModelWarned: true, updatedAt: now }
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
	baseline?: FermentV2Baseline,
	requirements?: FermentV2Requirements,
): SessionFermentV2 {
	if (!id.trim()) throw new Error("Ferment V2 ID cannot be empty.")
	if (tokenBudget !== undefined && !isPositiveInteger(tokenBudget)) {
		throw new Error("Ferment V2 token budget must be a positive integer.")
	}
	const normalizedObjective = normalizeObjective(objective)
	return {
		schemaVersion: 1,
		id,
		revision: 1,
		objective: normalizedObjective,
		name: deriveFermentV2Name(normalizedObjective, presentation?.title),
		status: "active",
		tokensUsed: 0,
		...(presentation ? { presentation } : {}),
		...(tokenBudget === undefined ? {} : { tokenBudget }),
		...(baseline ? { baseline } : {}),
		...(requirements ? { requirements } : {}),
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
	const verifierUsage = parseFermentV2VerifierUsage(value.verifierUsage)
	const requirementsUsage = parseFermentV2VerifierUsage(value.requirementsUsage)
	const baseline = parseFermentV2Baseline(value.baseline)
	const requirements = parseFermentV2Requirements(value.requirements, value, baseline)
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
		(value.evaluatorModelWarned !== undefined && value.evaluatorModelWarned !== true) ||
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
		name: deriveFermentV2Name(value.objective, isNonEmptyString(value.name) ? value.name : presentation?.title),
		status,
		...(presentation ? { presentation } : {}),
		...(status === "blocked" && value.blockedReason !== undefined
			? { blockedReason: normalizeBlockedReason(value.blockedReason) }
			: {}),
		...(completionConfidence && status === "complete" ? { completionConfidence } : {}),
		...(value.evaluationCount === undefined ? {} : { evaluationCount: value.evaluationCount }),
		...(lastEvaluation ? { lastEvaluation } : {}),
		...(value.evaluatorModelWarned === true ? { evaluatorModelWarned: true } : {}),
		...(value.consecutiveErrorTurns === undefined ? {} : { consecutiveErrorTurns: value.consecutiveErrorTurns }),
		...(value.unchangedContinuationTurns === undefined
			? {}
			: { unchangedContinuationTurns: value.unchangedContinuationTurns }),
		tokensUsed: value.tokensUsed ?? 0,
		...(value.tokenBudget === undefined ? {} : { tokenBudget: value.tokenBudget }),
		timeUsedMs: value.timeUsedMs ?? 0,
		...(verifierUsage ? { verifierUsage } : {}),
		...(requirementsUsage ? { requirementsUsage } : {}),
		...(baseline ? { baseline } : {}),
		...(requirements ? { requirements } : {}),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	}
}

/**
 * Parse the durable requirements record off a stored ferment. A malformed or
 * inconsistent record is dropped (the ferment entry stays valid and the goal
 * re-bootstraps requirements at its next safe checkpoint) rather than
 * rejecting the whole session entry. Consistency checks: the record's
 * objective revision cannot exceed the ferment's, and a claimed baseline must
 * match the ferment's actual baseline.
 */
function parseFermentV2Requirements(
	value: unknown,
	ferment: Record<string, unknown>,
	baseline: FermentV2Baseline | undefined,
): FermentV2Requirements | undefined {
	if (value === undefined) return undefined
	if (!isRecord(value) || value.schemaVersion !== 1) return undefined
	const provenance = FERMENT_V2_REQUIREMENTS_PROVENANCE.find((candidate) => candidate === value.provenance)
	const availability = FERMENT_V2_REQUIREMENTS_AVAILABILITY.find((candidate) => candidate === value.availability)
	if (
		provenance === undefined ||
		availability === undefined ||
		!isNonNegativeInteger(value.contractVersion) ||
		!isPositiveInteger(value.objectiveRevision) ||
		(typeof ferment.revision === "number" && value.objectiveRevision > ferment.revision) ||
		!isFermentV2ObjectiveDigest(value.objectiveDigest) ||
		!isNonEmptyString(value.objectiveText) ||
		!isNonNegativeInteger(value.idWatermark) ||
		(value.baselineCommit !== undefined && !isNonEmptyString(value.baselineCommit)) ||
		(value.draftRetried !== undefined && value.draftRetried !== true)
	) {
		return undefined
	}
	const unavailableReason =
		availability === "unavailable" && isNonEmptyString(value.unavailableReason) ? value.unavailableReason : undefined
	if (availability === "unavailable" && !unavailableReason) return undefined
	if (availability === "ready" && value.unavailableReason !== undefined) return undefined
	// Pending/unavailable refreshes retain the previous generation's items
	// for identity allocation; availability still prevents their verification.
	const items = parseVerifierRequirements(value.items)
	if (value.items !== undefined && (!Array.isArray(value.items) || (value.items.length > 0 && !items))) return undefined
	if (availability === "ready" && !items) return undefined
	const history = parseFermentV2RequirementsHistory(value.history)
	if (!history) return undefined
	const maxItemId = (items ?? []).reduce((max, item) => Math.max(max, Number(item.id.slice(1))), 0)
	if (value.idWatermark < maxItemId) return undefined
	const baselineCommit = typeof value.baselineCommit === "string" ? value.baselineCommit : undefined
	// A record claiming a baseline the ferment does not have (or that moved) is
	// inconsistent: drop the record instead of trusting the mismatched anchor.
	if (baselineCommit !== baseline?.commit) return undefined
	return {
		schemaVersion: 1,
		contractVersion: value.contractVersion,
		objectiveRevision: value.objectiveRevision,
		objectiveDigest: value.objectiveDigest,
		objectiveText: value.objectiveText,
		...(baselineCommit ? { baselineCommit } : {}),
		provenance,
		availability,
		...(unavailableReason ? { unavailableReason } : {}),
		...(items ? { items } : { items: [] }),
		idWatermark: value.idWatermark,
		history,
		...(value.draftRetried === true ? { draftRetried: true } : {}),
	}
}

function parseFermentV2RequirementsHistory(value: unknown): FermentV2RequirementsRevision[] | undefined {
	if (value === undefined) return []
	if (!Array.isArray(value)) return undefined
	const entries: FermentV2RequirementsRevision[] = []
	let previousVersion = 0
	for (const candidate of value) {
		if (!isRecord(candidate)) return undefined
		const items = parseVerifierRequirements(candidate.items)
		if (
			!isPositiveInteger(candidate.version) ||
			candidate.version <= previousVersion ||
			!items ||
			!isNonEmptyString(candidate.actor) ||
			!isPositiveInteger(candidate.objectiveRevision) ||
			!isNonEmptyString(candidate.acceptedAt) ||
			(candidate.reason !== undefined && !isNonEmptyString(candidate.reason))
		) {
			return undefined
		}
		previousVersion = candidate.version
		entries.push({
			version: candidate.version,
			items,
			actor: candidate.actor,
			...(candidate.reason !== undefined ? { reason: candidate.reason } : {}),
			objectiveRevision: candidate.objectiveRevision,
			acceptedAt: candidate.acceptedAt,
		})
	}
	return entries
}

function parseFermentV2Baseline(value: unknown): FermentV2Baseline | undefined {
	if (value === undefined) return undefined
	// A malformed baseline is dropped rather than rejecting the entry: the
	// baseline is optional metadata, and a ferment without one simply verifies
	// without baseline facts, flags, or a baseline worktree.
	if (!isRecord(value) || !isNonEmptyString(value.commit) || !isNonEmptyString(value.capturedAt)) return undefined
	return { commit: value.commit, capturedAt: value.capturedAt }
}

function parseFermentV2VerifierUsage(value: unknown): FermentV2VerifierUsage | undefined {
	if (value === undefined) return undefined
	if (
		!isRecord(value) ||
		!isNonNegativeInteger(value.runs) ||
		!isNonNegativeInteger(value.input) ||
		!isNonNegativeInteger(value.output) ||
		!isNonNegativeInteger(value.cacheRead) ||
		!isNonNegativeInteger(value.cacheWrite) ||
		!isNonNegativeInteger(value.totalTokens) ||
		typeof value.costUsd !== "number" ||
		!Number.isFinite(value.costUsd) ||
		value.costUsd < 0
	) {
		return undefined
	}
	return {
		runs: value.runs,
		input: value.input,
		output: value.output,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWrite,
		totalTokens: value.totalTokens,
		costUsd: value.costUsd,
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
	if (value.sameModelAsImplementer !== undefined && value.sameModelAsImplementer !== true) return undefined
	return {
		verdict,
		reason: value.reason,
		...(typeof value.model === "string" ? { model: value.model } : {}),
		...(value.sameModelAsImplementer === true ? { sameModelAsImplementer: true } : {}),
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
