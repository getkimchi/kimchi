export interface DiversifiableHit {
	memory?: string
	score?: number
}

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"are",
	"but",
	"not",
	"you",
	"all",
	"can",
	"her",
	"was",
	"one",
	"our",
	"out",
	"day",
	"get",
	"has",
	"him",
	"his",
	"how",
	"its",
	"new",
	"now",
	"old",
	"see",
	"two",
	"way",
	"who",
	"did",
	"yes",
	"that",
	"this",
	"with",
	"from",
	"they",
	"have",
	"were",
	"about",
	"which",
	"their",
	"there",
	"what",
	"when",
	"your",
	"will",
	"would",
	"could",
	"should",
	"into",
	"than",
	"then",
	"them",
	"some",
	"just",
	"like",
	"also",
	"because",
])

export function contentWords(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []).filter((word) => !STOPWORDS.has(word))
}

export function memorySimilarity(left: string, right: string): number {
	// Similarity must retain short identifiers unlike the coverage gate's
	// ≥3-character heuristic: "fact a" and "fact b" are not paraphrases.
	const words = (text: string): Set<string> =>
		new Set((text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((word) => !STOPWORDS.has(word)))
	const a = words(left)
	const b = words(right)
	if (a.size === 0 || b.size === 0) return left.trim().toLowerCase() === right.trim().toLowerCase() ? 1 : 0
	let intersection = 0
	for (const word of a) if (b.has(word)) intersection++
	return intersection / (a.size + b.size - intersection)
}

const NEGATION = /\b(?:not|never|no|avoid|instead|except|unless|only|always)\b/i
const EXPLANATION = /\b(?:because|since|therefore|however|although|unless|if|but)\b/i
const VALUE = /\b\d[\d./:-]*\b/

const GRAMMAR_WORDS = new Set([
	"a",
	"an",
	"as",
	"it",
	"of",
	"on",
	"in",
	"at",
	"to",
	"by",
	"is",
	"are",
	"be",
	"use",
	"used",
	"using",
	"prefer",
	"prefers",
	"select",
	"selected",
	"choose",
])

function differingSubstantives(left: string, right: string): boolean {
	const leftWords = new Set(
		(left.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((word) => !STOPWORDS.has(word) && !GRAMMAR_WORDS.has(word)),
	)
	const rightWords = new Set(
		(right.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((word) => !STOPWORDS.has(word) && !GRAMMAR_WORDS.has(word)),
	)
	const shared = [...leftWords].filter((word) => rightWords.has(word))
	if (shared.length < 3) return true
	return [...leftWords].some((word) => !rightWords.has(word)) && [...rightWords].some((word) => !leftWords.has(word))
}

function preservedEvidence(left: string, right: string): boolean {
	// Different values and polarity are not paraphrases. An explanation or
	// conditional clause can complement a settled choice rather than echo it.
	if (NEGATION.test(left) || NEGATION.test(right)) return true
	if (EXPLANATION.test(left) || EXPLANATION.test(right)) return true
	const a = left.match(VALUE)?.sort().join(" ") ?? ""
	const b = right.match(VALUE)?.sort().join(" ") ?? ""
	return a !== b || differingSubstantives(left, right)
}

/** Similar enough to share one retrieval slot, but never at the expense of
 * explicitly differing values or causal/corrective evidence. */
export function isNearDuplicate(left: string, right: string): boolean {
	if (left.trim().toLowerCase() === right.trim().toLowerCase()) return true
	return !preservedEvidence(left, right) && memorySimilarity(left, right) >= 0.65
}

/**
 * Rank by relevance while penalizing information already selected. IDs and
 * other subtype fields are preserved for provenance and management tools.
 * The algorithm is deterministic: equal values retain retrieval order.
 */
export function selectDiverseFacts<T extends DiversifiableHit>(hits: readonly T[]): T[] {
	const deduped = new Map<string, T>()
	for (const hit of hits) {
		const memory = hit.memory?.trim()
		if (!memory) continue
		const key = memory.toLowerCase()
		const old = deduped.get(key)
		if (!old || (hit.score ?? 0) > (old.score ?? 0)) deduped.set(key, hit)
	}
	const pool = [...deduped.values()]
	const representatives: T[] = []
	// Choose the most relevant member of each semantic cluster rather than a
	// fixed first fact; a later higher-scored paraphrase remains competitive.
	for (let i = 0; i < pool.length; i++) {
		const candidate = pool[i] as T
		const priorIndex = representatives.findIndex((other) => isNearDuplicate(candidate.memory ?? "", other.memory ?? ""))
		if (priorIndex < 0) {
			representatives.push(candidate)
		} else if ((candidate.score ?? 0) > (representatives[priorIndex]?.score ?? 0)) {
			representatives[priorIndex] = candidate
		}
	}
	const remaining = [...representatives]
	const selected: T[] = []
	while (remaining.length > 0) {
		let best = 0
		let bestValue = Number.NEGATIVE_INFINITY
		for (let i = 0; i < remaining.length; i++) {
			const candidate = remaining[i] as T
			let overlap = 0
			for (const prior of selected) {
				if (isNearDuplicate(candidate.memory ?? "", prior.memory ?? "")) overlap = 1
				else overlap = Math.max(overlap, memorySimilarity(candidate.memory ?? "", prior.memory ?? ""))
			}
			const utility = 0.75 * (candidate.score ?? 0) - 0.25 * overlap
			if (utility > bestValue) {
				best = i
				bestValue = utility
			}
		}
		selected.push(remaining.splice(best, 1)[0] as T)
	}
	return selected
}
