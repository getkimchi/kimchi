import { createHash } from "node:crypto"
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { textResult } from "../agents/tool-result.js"

export const RECORD_REQUIREMENTS_TOOL = "record_requirements"
export const REQUIREMENT_CATEGORIES = ["behavior", "constraint", "delivery"] as const

/** Maximum number of criteria in one requirements contract (existing bound; consolidate related clauses). */
export const FERMENT_V2_MAX_REQUIREMENTS = 64

const REQUIREMENT_ID_PATTERN = /^r[1-9][0-9]*$/
const OBJECTIVE_DIGEST_PATTERN = /^[0-9a-f]{64}$/

const field = () => Type.String({ minLength: 1, maxLength: 4_000 })
const requirementSchema = Type.Object({
	id: Type.String({ pattern: "^r[1-9][0-9]*$" }),
	requirement: field(),
	source: field(),
	acceptance: field(),
	category: Type.Union(REQUIREMENT_CATEGORIES.map((category) => Type.Literal(category))),
})

/** The shared complete-list schema (tool input and stored state share one parser). */
export const REQUIREMENTS_LIST_PARAMETER = Type.Array(requirementSchema, {
	minItems: 1,
	maxItems: FERMENT_V2_MAX_REQUIREMENTS,
})

export const REQUIREMENT_PARAMETERS = Type.Object({
	requirements: REQUIREMENTS_LIST_PARAMETER,
	reason: Type.Optional(field()),
	/** The contract version an addition extends; required whenever the list grows. */
	expectedVersion: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
})

export interface VerifierRequirement {
	id: string
	requirement: string
	/** Objective quotation or repository contract establishing the obligation. */
	source: string
	/** Observable condition that would establish satisfaction. */
	acceptance: string
	category: (typeof REQUIREMENT_CATEGORIES)[number]
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}

function requiredText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** Whether `value` is a stable requirement ID (`r1`, `r2`, …). */
export function isFermentV2RequirementId(value: unknown): value is string {
	return typeof value === "string" && REQUIREMENT_ID_PATTERN.test(value)
}

/** Whether `value` is a hex sha256 objective digest as stored on a requirements record. */
export function isFermentV2ObjectiveDigest(value: unknown): value is string {
	return typeof value === "string" && OBJECTIVE_DIGEST_PATTERN.test(value)
}

/**
 * One shared parser for a complete requirements list, used for stored state,
 * tool input, and headless artifacts: every item needs a stable ID, nonempty
 * requirement/source/acceptance, a valid category, and the list must be
 * unique-ID'd within the 64-item bound. Syntactic validity never claims a
 * source establishes the obligation — only that the shape is contract-grade.
 */
export function parseVerifierRequirements(
	value: unknown,
	max = FERMENT_V2_MAX_REQUIREMENTS,
): VerifierRequirement[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > max) return undefined
	const items: VerifierRequirement[] = []
	for (const candidate of value) {
		if (!isRecordValue(candidate) || !isFermentV2RequirementId(candidate.id)) return undefined
		const requirement = requiredText(candidate.requirement)
		const source = requiredText(candidate.source)
		const acceptance = requiredText(candidate.acceptance)
		const category = REQUIREMENT_CATEGORIES.find((entry) => entry === candidate.category)
		if (!requirement || !source || !acceptance || !category) return undefined
		items.push({ id: candidate.id, requirement, source, acceptance, category })
	}
	if (new Set(items.map((item) => item.id)).size !== items.length) return undefined
	return items
}

/**
 * The next ID watermark: IDs already allocated (≤ watermark) stay valid only
 * for obligations present in the current items (stable obligations keep their
 * IDs); fresh obligations must use IDs above the watermark, so retired IDs are
 * never reused.
 */
export function nextRequirementIdWatermark(
	previous: number,
	items: readonly VerifierRequirement[],
	currentItems: readonly VerifierRequirement[],
): number {
	const currentIds = new Set(currentItems.map((item) => item.id))
	let watermark = previous
	for (const item of items) {
		const id = Number(item.id.slice(1))
		if (id <= previous && !currentIds.has(item.id)) {
			throw new Error(
				`Ferment V2 requirements rejected: requirement ID ${item.id} was retired and cannot be reused; allocate a fresh ID.`,
			)
		}
		if (id > watermark) watermark = id
	}
	return watermark
}

/** Stable digest binding a requirements contract to the exact objective text it was drafted for. */
export function digestFermentV2ObjectiveText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex")
}

/**
 * Stable digest identifying one exact amendment proposal against one contract
 * version: the complete replacement list (order-insensitive, sorted by ID)
 * plus the implementer's evidence. Rejected-proposal caching keys on it, so
 * identical retries for the same version short-circuit without a ruling while
 * changed evidence or a changed version permits reconsideration.
 */
export function digestRequirementsAmendmentProposal(
	contractVersion: number,
	items: readonly VerifierRequirement[],
	reason: string,
): string {
	const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
	return createHash("sha256")
		.update(JSON.stringify({ contractVersion, items: sorted, reason }))
		.digest("hex")
}

/** Order-insensitive equality by ID with exact field equality per item. */
function sameRequirementList(a: readonly VerifierRequirement[], b: readonly VerifierRequirement[]): boolean {
	if (a.length !== b.length) return false
	const byId = new Map(b.map((item) => [item.id, item]))
	return a.every((item) => {
		const other = byId.get(item.id)
		return other !== undefined && sameRequirementItem(item, other)
	})
}

/** Order-insensitive whole-list equality by ID with exact field equality per item. */
export function isSameRequirementSet(a: readonly VerifierRequirement[], b: readonly VerifierRequirement[]): boolean {
	return sameRequirementList(a, b)
}

/** Exact field equality for one requirement item. */
export function sameRequirementItem(a: VerifierRequirement, b: VerifierRequirement): boolean {
	return (
		a.id === b.id &&
		a.requirement === b.requirement &&
		a.source === b.source &&
		a.acceptance === b.acceptance &&
		a.category === b.category
	)
}

/** Highest r<n> numeric ID in a list (0 when empty). */
function maxRequirementId(items: readonly VerifierRequirement[] | undefined): number {
	return (items ?? []).reduce((max, item) => Math.max(max, Number(item.id.slice(1))), 0)
}

/** How a submitted list differs from the current one: additions plus changed or missing existing items. */
function diffRequirementList(
	current: readonly VerifierRequirement[],
	submitted: readonly VerifierRequirement[],
): { added: VerifierRequirement[]; changed: string[]; missing: string[] } {
	const byId = new Map(submitted.map((item) => [item.id, item]))
	const changed = current
		.filter((item) => {
			const other = byId.get(item.id)
			return other !== undefined && !sameRequirementItem(item, other)
		})
		.map((item) => item.id)
	const missing = current.filter((item) => !byId.has(item.id)).map((item) => item.id)
	const currentIds = new Set(current.map((item) => item.id))
	const added = submitted.filter((item) => !currentIds.has(item.id))
	return { added, changed, missing }
}

/** One computed difference between the current contract and a proposed amendment. */
export interface RequirementsAmendmentDiff {
	added: readonly VerifierRequirement[]
	changed: readonly { current: VerifierRequirement; proposed: VerifierRequirement }[]
	removed: readonly VerifierRequirement[]
}

/**
 * Compute the host-side diff between the current contract and a complete
 * proposed replacement, enforcing the amendment ID rules: an existing ID may
 * keep its obligation (unchanged or changed in place), a new obligation must
 * use a fresh ID above the allocation watermark, and a retired ID (at or
 * below the watermark, absent from the current items) is never reused.
 * Returns `undefined` for an invalid proposal (retired-ID reuse); the caller
 * reports the reason.
 */
export function diffRequirementsAmendment(
	current: readonly VerifierRequirement[],
	proposed: readonly VerifierRequirement[],
	idWatermark: number,
): RequirementsAmendmentDiff | undefined {
	const currentById = new Map(current.map((item) => [item.id, item]))
	const added: VerifierRequirement[] = []
	const changed: { current: VerifierRequirement; proposed: VerifierRequirement }[] = []
	for (const item of proposed) {
		const existing = currentById.get(item.id)
		if (existing) {
			if (!sameRequirementItem(existing, item)) changed.push({ current: existing, proposed: item })
			continue
		}
		if (Number(item.id.slice(1)) <= idWatermark) return undefined
		added.push(item)
	}
	const proposedIds = new Set(proposed.map((item) => item.id))
	const removed = current.filter((item) => !proposedIds.has(item.id))
	return { added, changed, removed }
}

/** One addition a final review accepted against the contract it was seeded with. */
export interface RequirementAddition {
	/** The new obligations (fresh IDs only; nothing existing changed). */
	items: readonly VerifierRequirement[]
	/** The source-grounded reason the review accepted them. */
	reason: string
	/** The in-review contract version this addition extends (the seeded version, +1 per accepted addition). */
	basedOnVersion: number
}

export interface RequirementSnapshot {
	requirements: readonly VerifierRequirement[]
	/** Required for revisions, including additions and removals. */
	reason?: string
}

export interface RequirementLedgerOptions {
	/** The persisted contract's list; the session may only acknowledge it or add omitted obligations, never replace it. */
	seeded?: readonly VerifierRequirement[]
	/** Where the seeded contract came from (for the tool's acknowledgement message). */
	seededReason?: string
	/** The persisted contract's version; additions must state it (then each advance) as their base. */
	seededVersion?: number
	/** Highest r<n> ID ever allocated; additions must use fresh IDs above it. */
	idWatermark?: number
}

/**
 * One evaluator session owns the list; the host preserves its history and
 * checks coverage. When a persisted contract is seeded, the session starts
 * with it: `record_requirements` acknowledges the identical list (which
 * releases the implementation context, as before) and otherwise permits
 * exactly additions — fresh IDs above the allocated watermark, a
 * source-grounded reason, and the contract version the addition extends.
 * Existing IDs, criteria, and categories can never change, weaken, or
 * disappear through this phase; a proposed change or removal is rejected
 * with instructions to surface it as a `continue` proposal instead (the
 * obligation stays binding until an amendment path exists). Accepted
 * additions join the list immediately, so coverage requires their outcomes
 * in this same review: a fully verified addition may permit `met`, an unmet
 * or unverified one forces continuation. The host applies the accepted
 * additions durably when the review settles.
 */
export function createRequirementLedger(validationContext: string, options?: RequirementLedgerOptions) {
	const seeded = options?.seeded
	const seededVersion = options?.seededVersion ?? 1
	// The running ID watermark: advances past every ID this review accepted, so
	// a chained addition must clear not just the persisted watermark but every
	// ID allocated in this session — matching exactly what the host's durable
	// application will accept at settle time.
	let watermark = options?.idWatermark ?? maxRequirementId(seeded)
	const validationContextReleased = { current: !seeded }
	const current: VerifierRequirement[] = seeded ? [...seeded] : []
	// The in-review contract version: starts at the persisted version and
	// advances by one per accepted addition, so a chained addition states the
	// version the previous acceptance produced.
	let reviewVersion = seededVersion
	const additions: RequirementAddition[] = []
	const history: RequirementSnapshot[] = seeded
		? [{ requirements: seeded, ...(options?.seededReason ? { reason: options.seededReason } : {}) }]
		: []
	const releaseContext = () => {
		const release = seeded && !validationContextReleased.current
		validationContextReleased.current = true
		return release ? validationContext : undefined
	}
	const extension: InlineExtension = (pi) => {
		pi.registerTool(
			defineTool({
				name: RECORD_REQUIREMENTS_TOOL,
				label: "Record Requirements",
				description: seeded
					? "Acknowledge the persisted requirements contract by returning exactly its list, or add omitted task-grounded obligations: submit the current list verbatim plus the additions with fresh r<n> IDs, a source-grounded reason, and expectedVersion set to the current contract version. Existing items never change or get removed here. Verify every current requirement."
					: "Record observable requirements before validating the implementation. Use stable r1, r2, … IDs. Later calls replace the complete list and require a source-grounded reason for every revision. Acceptance continues this same session and supplies implementation context.",
				parameters: REQUIREMENT_PARAMETERS,
				execute: async (_id, params) => {
					const requirements = parseVerifierRequirements(params.requirements)
					if (!requirements) {
						return {
							...textResult(
								"Requirements rejected: provide distinct IDs and nonempty requirement, source, and acceptance fields.",
							),
							isError: true,
						}
					}
					const previous = history.at(-1)
					if (previous && sameRequirementList(previous.requirements, requirements)) {
						// The acknowledgement is the seeded review's validation-context
						// handoff: the contract was established independently, so the
						// implementer narrative is released with the first accepted
						// call (an acknowledgement or an addition) only.
						const context = releaseContext()
						return textResult(
							[
								seeded
									? "Persisted requirements contract acknowledged. Continue validating every listed requirement; cite their IDs in your checks."
									: "Requirements already recorded. Continue validating them; cite their IDs in your checks.",
								...(context ? [context] : []),
							].join("\n\n"),
						)
					}
					if (seeded) {
						const { added, changed, missing } = diffRequirementList(current, requirements)
						if (changed.length > 0 || missing.length > 0) {
							return {
								...textResult(
									[
										"Rejected: record_requirements cannot change, weaken, recategorize, or remove an existing criterion in this review — the supplied list must keep every current item verbatim; only additions of omitted obligations are permitted (fresh r<n> IDs above the allocated watermark, a source-grounded reason, and expectedVersion set to the current contract version).",
										"For a proposed change or removal, return a continue verdict whose reason names the proposal and its rationale: the existing obligation stays binding until an amendment path exists, so the proposal is actionable context, not an accepted rewrite.",
									].join(" "),
								),
								isError: true,
							}
						}
						const reason = params.reason?.trim()
						if (!reason) {
							return {
								...textResult(
									"Addition rejected: give a source-grounded reason quoting where the objective or a repository contract requires each omitted obligation.",
								),
								isError: true,
							}
						}
						if (params.expectedVersion !== reviewVersion) {
							return {
								...textResult(
									`Addition rejected: state expectedVersion as ${reviewVersion} (the current contract version for this review).`,
								),
								isError: true,
							}
						}
						if (added.length > 0) {
							try {
								watermark = nextRequirementIdWatermark(watermark, added, current)
							} catch {
								return {
									...textResult(
										`Addition rejected: allocate fresh requirement IDs above r${watermark}; retired IDs are never reused and existing criteria keep their IDs.`,
									),
									isError: true,
								}
							}
							current.push(...added)
							additions.push({ items: added, reason, basedOnVersion: params.expectedVersion })
							reviewVersion += 1
							history.push({ requirements: [...current], reason })
							const context = releaseContext()
							return textResult(
								[
									`Addition accepted: ${added.map((item) => item.id).join(", ")} joined the requirements contract (this review's version is now ${reviewVersion}; the host applies the additions durably when the review settles). The added obligations are binding immediately: verify each one independently and cite their IDs, exactly like the persisted items.`,
									...(context ? [context] : []),
								].join("\n\n"),
							)
						}
						// No net change relative to the current list is the acknowledgement.
						return textResult(
							"Persisted requirements contract acknowledged. Continue validating every listed requirement; cite their IDs in your checks.",
						)
					}
					const reason = params.reason?.trim()
					if (previous && !reason) {
						return {
							...textResult(
								"Revision rejected: explain the task or repository evidence requiring this change, including removed requirements. Preserve IDs for unchanged obligations.",
							),
							isError: true,
						}
					}
					current.splice(0, current.length, ...requirements)
					history.push({ requirements, ...(reason ? { reason } : {}) })
					return textResult(
						[
							`Requirements recorded (revision ${history.length}). Validate every requirement against its source and acceptance condition. Include requirementId in every final check.`,
							JSON.stringify(requirements),
							...(previous ? [] : [validationContext]),
						].join("\n\n"),
					)
				},
			}),
		)
	}
	return {
		extension,
		history,
		/** Additions this review accepted, in acceptance order. */
		additions,
		/** The persisted contract version this review started from. */
		baseVersion: seededVersion,
		/** The in-review contract version after this session's accepted additions. */
		version: () => reviewVersion,
		category: (id: string | undefined) => current.find((item) => item.id === id)?.category,
		coverageGap(
			checks: readonly { requirementId?: string; category?: string; kind?: string }[] | undefined,
		): string | undefined {
			if (!current.length)
				return "Call record_requirements with the task's sourced acceptance conditions before returning a verdict, then validate them."
			const unknown = checks?.find((check) => !current.some((item) => item.id === check.requirementId))
			const gaps: string[] = []
			if (unknown)
				gaps.push(
					"Every check must reference a current recorded requirement using requirementId; record newly discovered obligations before checking them.",
				)
			const missing = current.filter((item) => !checks?.some((check) => check.requirementId === item.id))
			if (missing.length)
				gaps.push(
					`${missing.map((item) => `Recorded requirement ${item.id} (${item.requirement.slice(0, 120)}) has no outcome.`).join(" ")} Validate every missing requirement and include cited checks.`,
				)
			return gaps.length ? gaps.join(" ") : undefined
		},
	}
}
