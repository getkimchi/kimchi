import { describe, expect, it } from "vitest"
import { findSupersededIds, type SupersedeCandidate } from "./supersede.js"

describe("findSupersededIds", () => {
	const candidates: SupersedeCandidate[] = [
		{ id: "old-1", memory: "user drinks regular coffee every morning", score: 0.8 },
		{ id: "old-2", memory: "user works as a software engineer", score: 0.7 },
	]

	it("returns only ids the judge named that also exist among the candidates", async () => {
		const judged: string[] = []
		const ids = await findSupersededIds(
			["user switched to decaf coffee last month"],
			async () => candidates,
			async (_facts, _cands) => {
				judged.push("called")
				return ["old-1", "hallucinated-id"]
			},
		)
		expect(judged).toEqual(["called"])
		expect(ids).toEqual(["old-1"])
	})

	it("deduplicates candidates across facts before judging", async () => {
		const seen: SupersedeCandidate[][] = []
		await findSupersededIds(
			["switched to decaf", "also uses decaf beans"],
			async () => candidates,
			async (_facts, cands) => {
				seen.push(cands)
				return []
			},
		)
		expect(seen).toHaveLength(1) // one batched judge call per invocation
		expect(seen[0]).toHaveLength(2)
	})

	it("skips the judge entirely when there are no facts", async () => {
		let calls = 0
		const ids = await findSupersededIds(
			[],
			async () => candidates,
			async () => {
				calls += 1
				return []
			},
		)
		expect(ids).toEqual([])
		expect(calls).toBe(0)
	})

	it("skips the judge when search returns no candidates", async () => {
		let calls = 0
		const ids = await findSupersededIds(
			["a brand new fact"],
			async () => [],
			async () => {
				calls += 1
				return []
			},
		)
		expect(ids).toEqual([])
		expect(calls).toBe(0)
	})
})
