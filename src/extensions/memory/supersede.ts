/**
 * Force-DELETE+ADD supersede: mem0's TS write path is add-only, so a new
 * fact that changes a previously stored value leaves the stale row behind
 * (spike-verified twice — see docs/memory-extension.md). Before facts
 * are added, related existing memories are judged against them and the
 * explicitly-replaced ones are deleted.
 *
 * The judge is deps-injected and stays conservative: only explicit
 * changed-value evidence deletes; complementary details never do.
 * Pure — unit-testable under Node.
 */
import { batchChoice, type DecisionGateOptions } from "./decision-gate.js"
import { supersedeQuestion, supersedeState } from "./gates.js"

export interface SupersedeCandidate {
	id: string
	memory: string
	score?: number
}

/** Returns the ids of candidates the new facts explicitly replace. */
export type SupersedeJudge = (newFacts: string[], candidates: SupersedeCandidate[]) => Promise<string[]>

/**
 * Decision-model judge (spike E7 Part A): d3 matched the chat judge on
 * 4/5 labeled cases and caught the preference reversal the chat judge
 * missed, while its delete/keep criteria carry the conservative rules
 * (complementary details survive; unsure means keep). Throws on gate
 * failure — the caller's per-batch catch is the fail-open (keeps all).
 */
export function createDecisionSupersedeJudge(gate: DecisionGateOptions): SupersedeJudge {
	return async (newFacts, candidates) => {
		if (candidates.length === 0) return []
		const answers = await batchChoice(
			gate,
			supersedeState(newFacts, candidates),
			candidates.map((candidate) => candidate.memory),
			(_memory, index) => {
				const candidate = candidates[index]
				// batchChoice guarantees the index alignment — a miss is a caller bug.
				if (!candidate) throw new Error(`supersede judge: batch index ${index} out of candidate range`)
				return supersedeQuestion(candidate)
			},
		)
		const deleted: string[] = []
		for (const [i, candidate] of candidates.entries()) {
			if (answers[i]?.choice === "delete") deleted.push(candidate.id)
		}
		return deleted
	}
}

export async function findSupersededIds(
	newFacts: string[],
	searchRelated: (fact: string) => Promise<SupersedeCandidate[]>,
	judge: SupersedeJudge,
): Promise<string[]> {
	if (newFacts.length === 0) return []
	const byId = new Map<string, SupersedeCandidate>()
	for (const fact of newFacts) {
		for (const candidate of await searchRelated(fact)) {
			if (!candidate.memory) continue
			if (!byId.has(candidate.id)) byId.set(candidate.id, candidate)
		}
	}
	const candidates = [...byId.values()]
	if (candidates.length === 0) return []
	const judged = await judge(newFacts, candidates)
	const known = new Set(byId.keys())
	return judged.filter((id) => known.has(id))
}
