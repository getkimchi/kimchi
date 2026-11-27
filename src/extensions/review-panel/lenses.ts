import { ReviewTargetError } from "../review-targets/types.js"

export type ReviewLensId = "spec" | "standards" | "operational" | "adversarial" | "security"

export interface ReviewLensDefinition {
	id: ReviewLensId
	focus: string
}

export interface RequiredReviewLens {
	id: ReviewLensId
	reason: string
}

export interface ReviewPanelArguments {
	/** Explicit --lens values, deduplicated in command-line order. Empty means the default panel unless all is set. */
	lenses: ReviewLensId[]
	all: boolean
	concurrency: number
}

export interface ReviewPanelSelectionInput {
	lenses?: readonly ReviewLensId[]
	all?: boolean
	concurrency?: number
	requiredLenses?: readonly RequiredReviewLens[]
}

export interface SelectedReviewLens extends ReviewLensDefinition {
	writer: string
	reasons: string[]
}

export interface ResolvedReviewPanel {
	lenses: SelectedReviewLens[]
	requestedConcurrency: number
	slotCount: number
}

export const DEFAULT_REVIEW_PANEL = ["spec", "standards", "operational", "adversarial"] as const
export const DEFAULT_REVIEW_CONCURRENCY = 2

export const REVIEW_LENSES: readonly ReviewLensDefinition[] = [
	{
		id: "spec",
		focus:
			"Spec and correctness. Check intended behavior, invariants, missing requirements, and scope. Record missing spec context and continue with correctness review.",
	},
	{
		id: "standards",
		focus:
			"Standards and maintainability. Cite documented standards and flag concrete maintenance costs that tooling does not already catch.",
	},
	{
		id: "operational",
		focus:
			"Operational risk. Examine deployment and production failures, including mixed versions, migrations and rollback, dependency outages, resource use, and whether operators can detect and recover from failures. Flag security concerns that surface in those paths, such as sensitive data in failure logs.",
	},
	{
		id: "adversarial",
		focus:
			"Adversarial correctness. Stress ordinary behavior with boundary inputs, unusual sequences, cancellation, retries, and partial failures. Write targeted regression tests when permitted.",
	},
	{
		id: "security",
		focus:
			"Security. Review authorization, input validation, trust boundaries, and sensitive data handling. Use targeted defensive regression tests when permitted.",
	},
] as const

const lensById = new Map(REVIEW_LENSES.map((lens) => [lens.id, lens]))

export function isReviewLensId(value: string): value is ReviewLensId {
	return lensById.has(value as ReviewLensId)
}

export function assertReviewLensId(value: string): ReviewLensId {
	if (!isReviewLensId(value)) {
		throw new ReviewTargetError(
			"invalid_arguments",
			`Unknown review lens "${value}". Available lenses: ${REVIEW_LENSES.map((lens) => lens.id).join(", ")}.`,
		)
	}
	return value
}

/** Resolve CLI-style selection with trusted policy additions. Required lenses are
 * deliberately not read from the reviewed checkout; stage 5 supplies them from
 * the invoking session's trusted settings. */
export function resolveReviewPanel(input: ReviewPanelSelectionInput = {}): ResolvedReviewPanel {
	const explicit = [...new Set(input.lenses ?? [])]
	for (const lens of explicit) assertReviewLensId(lens)
	if (input.all && explicit.length > 0)
		throw new ReviewTargetError("invalid_arguments", "--lens cannot be combined with --all.")
	const concurrency = input.concurrency ?? DEFAULT_REVIEW_CONCURRENCY
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
		throw new ReviewTargetError("invalid_arguments", "--concurrency must be a positive integer.")
	}
	const reasons = new Map<ReviewLensId, string[]>()
	const select = (id: ReviewLensId, reason: string) => {
		const existing = reasons.get(id) ?? []
		if (!existing.includes(reason)) existing.push(reason)
		reasons.set(id, existing)
	}
	if (input.all) {
		for (const lens of REVIEW_LENSES) select(lens.id, "Selected with --all.")
	} else if (explicit.length > 0) {
		for (const id of explicit) select(id, "Selected with --lens.")
	} else {
		for (const id of DEFAULT_REVIEW_PANEL) select(id, "Selected by the default panel.")
	}
	for (const required of input.requiredLenses ?? []) {
		assertReviewLensId(required.id)
		if (typeof required.reason !== "string" || !required.reason.trim() || required.reason.includes("\0")) {
			throw new ReviewTargetError(
				"invalid_arguments",
				`Policy-required lens ${required.id} needs a non-empty reason without NUL.`,
			)
		}
		select(required.id, `Required by policy: ${required.reason.trim()}`)
	}
	// Registry order gives stable queueing and output regardless of policy additions.
	const lenses = REVIEW_LENSES.filter((lens) => reasons.has(lens.id)).map((lens) => ({
		...lens,
		writer: lens.id,
		reasons: reasons.get(lens.id) ?? [],
	}))
	return { lenses, requestedConcurrency: concurrency, slotCount: Math.min(concurrency, lenses.length) }
}
