import { describe, expect, it } from "vitest"
import { createDecisionSupersedeJudge, findSupersededIds, type SupersedeCandidate } from "./supersede.js"

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

describe("createDecisionSupersedeJudge (E7 Part A)", () => {
	const candidates: SupersedeCandidate[] = [
		{ id: "m1", memory: "the user has 17 new postcards", score: 0.9 },
		{ id: "m2", memory: "the user gardens every summer", score: 0.4 },
	]

	function judgeFetch(verdicts: Record<string, "delete" | "keep">): typeof fetch {
		const fetchImpl: typeof fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as {
				state: string
				questions: Record<string, { instructions: string }>
			}
			const answers = Object.fromEntries(
				Object.entries(body.questions).map(([key, q]) => {
					// The question embeds the candidate id's first 8 chars and start
					// of the memory text; pick the verdict by text match.
					const [id, verdict] = Object.entries(verdicts).find(
						([vid]) => q.instructions.includes(vid) || q.instructions.includes(vid.slice(0, 8)),
					) ?? ["", "keep"]
					void id
					return [
						key,
						{
							type: "choice",
							choice: verdict,
							probabilities: {
								delete: verdict === "delete" ? 0.96 : 0.04,
								keep: verdict === "keep" ? 0.96 : 0.04,
							},
							confidence: 0.9,
						},
					]
				}),
			)
			return new Response(JSON.stringify({ answers, usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200 })
		}
		return fetchImpl
	}

	it("deletes only what d3 marks (state carries both lists; one batched call)", async () => {
		const judge = createDecisionSupersedeJudge({
			endpoint: "https://gw.test/typesafe/v1/systemone",
			apiKey: "k",
			fetchImpl: judgeFetch({ m1: "delete", m2: "keep" }),
		})
		const deleted = await judge(["the user now has 25 new postcards, up from 17"], candidates)
		expect(deleted).toEqual(["m1"])
	})

	it("keep-on-unsure contract: a keep verdict never deletes", async () => {
		const judge = createDecisionSupersedeJudge({
			endpoint: "https://gw.test/typesafe/v1/systemone",
			apiKey: "k",
			fetchImpl: judgeFetch({ m1: "keep", m2: "keep" }),
		})
		expect(await judge(["the user now has 25 new postcards"], candidates)).toEqual([])
	})

	it("gate failure propagates — the drain's per-batch catch is the fail-open", async () => {
		const down = async () => new Response(JSON.stringify({ error: "quota" }), { status: 401 })
		const judge = createDecisionSupersedeJudge({
			endpoint: "https://gw.test/typesafe/v1/systemone",
			apiKey: "k",
			fetchImpl: down,
			maxRetries: 0,
		})
		await expect(judge(["new"], candidates)).rejects.toThrow()
	})
})
