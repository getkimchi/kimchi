/**
 * Memory digest builder — the value gate for auto-injection.
 *
 * Auto-injected context must earn its tokens: retrieval is query-grounded
 * (the session's opening prompt), relevance-thresholded, tightly capped,
 * and empty-digest-is-normal — when nothing clears the bar, no memory
 * section is injected at all.
 *
 * Pure — unit-testable under Node.
 */
import {
	DIGEST_MAX_FACTS,
	DIGEST_MAX_TOKENS,
	DIGEST_SCORE_THRESHOLD,
	tokensEstimated,
} from "./config.js"

export interface MemorySearchHit {
	memory?: string
	score?: number
}

export interface DigestCandidate {
	text: string
	score: number
}

/** Composition log entry — the input for the digest-value measurement. */
export interface DigestComposition {
	/** Facts that cleared the value bar. */
	facts: number
	/** Candidates considered before gating. */
	considered: number
	/** Dropped by the relevance threshold. */
	belowThreshold: number
	/** Dropped by the top-N cap after clearing the threshold. */
	overCap: number
	/** Dropped by the token budget. */
	overBudget: number
	tokensEstimated: number
}

export interface DigestResult {
	text: string
	composition: DigestComposition
}

/**
 * Build the digest from search hits. Returns undefined when nothing clears
 * the value bar — the normal outcome for unrelated sessions; the caller
 * must inject nothing in that case.
 */
export function buildMemoryDigest(hits: MemorySearchHit[]): DigestResult | undefined {
	const candidates: DigestCandidate[] = []
	for (const hit of hits) {
		const text = (hit.memory ?? "").trim()
		const score = hit.score ?? 0
		if (!text) continue
		candidates.push({ text, score })
	}

	const composition: DigestComposition = {
		facts: 0,
		considered: candidates.length,
		belowThreshold: 0,
		overCap: 0,
		overBudget: 0,
		tokensEstimated: 0,
	}

	// Highest score first, stable for equal scores (deterministic truncation).
	const ranked = [...candidates].sort((a, b) => b.score - a.score)

	const kept: DigestCandidate[] = []
	for (const candidate of ranked) {
		if (candidate.score < DIGEST_SCORE_THRESHOLD) {
			composition.belowThreshold += 1
			continue
		}
		if (kept.length >= DIGEST_MAX_FACTS) {
			composition.overCap += 1
			continue
		}
		kept.push(candidate)
	}

	if (kept.length === 0) return undefined

	// Enforce the token budget over the whole section, dropping the
	// lowest-scored facts first (they are at the tail).
	for (;;) {
		const text = kept.map((c) => `- ${c.text}`).join("\n")
		const section = digestSection(text)
		const used = tokensEstimated(section.length)
		if (used <= DIGEST_MAX_TOKENS || kept.length === 1) {
			composition.facts = kept.length
			composition.tokensEstimated = used
			if (used > DIGEST_MAX_TOKENS) {
				// Single fact exceeds the budget — hard-truncate its text.
				composition.overBudget += 1
				const truncated = truncateSection(kept[0].text)
				composition.tokensEstimated = tokensEstimated(truncated.length)
				return { text: truncated, composition }
			}
			return { text: section, composition }
		}
		kept.pop()
		composition.overBudget += 1
	}
}

/** The stable-prefix section appended to the system prompt. */
export function digestSection(body: string): string {
	return `\n\n## User memory (from previous sessions, local-only)\n${body}`
}

function truncateSection(text: string): string {
	// Account for the full prefix ("- " included) and the ellipsis so the
	// result never exceeds the budget.
	const prefix = digestSection("- ")
	const maxBodyChars = DIGEST_MAX_TOKENS * 4 - prefix.length - 1
	const truncated = text.length > maxBodyChars ? `${text.slice(0, maxBodyChars)}…` : text
	return digestSection(`- ${truncated}`)
}
