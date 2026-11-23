import { createHash } from "node:crypto"

/**
 * A generic retrieval need, not an attempt to reverse-engineer tool state.
 * Free text stays free text: evidence is not promoted to an observation
 * schema, and no project- or task-specific field is required.
 */
export interface RecallNeed {
	taskScope?: string
	environmentScope?: string
	objective?: string
	blocker?: string
	failedApproaches: readonly string[]
	requestedKnowledge?: string
	currentEvidence?: string
	recentContext?: string
}

export interface RecallNeedInput extends Omit<RecallNeed, "objective" | "failedApproaches"> {
	objective?: string
	failedApproaches?: readonly string[]
	evidence?: readonly string[]
}

const clamp = (text: string | undefined, max = 1200): string | undefined => {
	const trimmed = text?.trim()
	if (!trimmed) return undefined
	if (trimmed.length <= max) return trimmed
	return `${trimmed.slice(0, Math.floor(max * 0.7)).trimEnd()}\n…\n${trimmed.slice(-Math.floor(max * 0.3)).trimStart()}`
}

const identityKey = (text: string): string => {
	const normalized = text.toLowerCase().replace(/\s+/g, " ").trim()
	return createHash("sha256").update(normalized).digest("hex")
}

export function createRecallNeed(input: RecallNeedInput): RecallNeed {
	const objective = clamp(input.objective)
	return {
		...(clamp(input.taskScope) ? { taskScope: clamp(input.taskScope) } : {}),
		...(clamp(input.environmentScope) ? { environmentScope: clamp(input.environmentScope) } : {}),
		objective,
		...(clamp(input.blocker) ? { blocker: clamp(input.blocker) } : {}),
		failedApproaches: (input.failedApproaches ?? [])
			.map((value) => clamp(value))
			.filter((value): value is string => Boolean(value)),
		...(clamp(input.requestedKnowledge) ? { requestedKnowledge: clamp(input.requestedKnowledge) } : {}),
		...(clamp(input.evidence?.findLast((value) => value.trim().length > 0))
			? { currentEvidence: clamp(input.evidence?.findLast((value) => value.trim().length > 0)) }
			: {}),
		...(clamp(input.recentContext) ? { recentContext: clamp(input.recentContext) } : {}),
	}
}

/** Stable need identity: an evidence change is not a new task, and two
 * identical need shapes never re-embed as if new facts had appeared. */
export function recallNeedFingerprint(need: RecallNeed): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				...need,
				failedApproaches: [...need.failedApproaches].sort(),
			}),
		)
		.digest("hex")
		.slice(0, 16)
}

/** At most three distinct lookup strings; blending stays bounded by the
 * caller's existing query budget. Any leaky lexical suffix cap can still
 * trim the blend without silently lengthening request fan-out. */
export function recallNeedFacets(need: RecallNeed): string[] {
	const objective = clamp(
		[need.objective, need.blocker ? `Unresolved blocker: ${need.blocker}` : ""].filter(Boolean).join("\n"),
	)
	const facets = objective ? [objective] : []
	if (need.currentEvidence) facets.push(need.currentEvidence)
	if (
		need.recentContext &&
		!sameRecallFacet(need.recentContext, need.objective) &&
		!sameRecallFacet(need.recentContext, need.currentEvidence)
	)
		facets.push(need.recentContext)
	return [
		...new Map(
			facets.filter((value): value is string => Boolean(value)).map((value) => [identityKey(value), value]),
		).values(),
	]
}

export function sameRecallFacet(left: string | undefined, right: string | undefined): boolean {
	return Boolean(left && right && identityKey(left) === identityKey(right))
}

export interface RecallNeedChangeOptions {
	previousFingerprint?: string
	fingerprint: string
	requestedAt: number
	lastEvaluatedAt?: number
	cooldownMs: number
}

export function shouldEvaluateRecallNeed(options: RecallNeedChangeOptions): boolean {
	if (options.previousFingerprint === options.fingerprint) return false
	return options.lastEvaluatedAt === undefined || options.requestedAt - options.lastEvaluatedAt >= options.cooldownMs
}
