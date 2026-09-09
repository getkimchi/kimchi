/**
 * Force-DELETE+ADD supersede: mem0's TS write path is add-only, so a new
 * fact that changes a previously stored value leaves the stale row behind
 * (spike-verified twice — benchmark/memory-spike/results/). Before facts
 * are added, related existing memories are judged against them and the
 * explicitly-replaced ones are deleted.
 *
 * The judge is deps-injected and stays conservative: only explicit
 * changed-value evidence deletes; complementary details never do.
 * Pure — unit-testable under Node.
 */

export interface SupersedeCandidate {
	id: string
	memory: string
	score?: number
}

/** Returns the ids of candidates the new facts explicitly replace. */
export type SupersedeJudge = (
	newFacts: string[],
	candidates: SupersedeCandidate[],
) => Promise<string[]>

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
