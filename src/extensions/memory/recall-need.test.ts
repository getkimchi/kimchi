import { describe, expect, it } from "vitest"
import { createRecallNeed, recallNeedFacets, recallNeedFingerprint, shouldEvaluateRecallNeed } from "./recall-need.js"

describe("generic recall needs", () => {
	it("uses the latest observable evidence and at most three lookup facets", () => {
		const need = createRecallNeed({
			objective: "Find the convention the project settled on",
			failedApproaches: ["Inspected the wrong configuration file"],
			evidence: ["first observable output", "latest observable output"],
			recentContext: "A genuinely new request for additional context",
		})
		expect(need.failedApproaches).toEqual(["Inspected the wrong configuration file"])
		expect(recallNeedFacets(need)).toEqual([
			"Find the convention the project settled on",
			"latest observable output",
			"A genuinely new request for additional context",
		])
	})

	it("does not duplicate evidence or objective across facets", () => {
		const need = createRecallNeed({
			objective: "Find the proven adapter",
			evidence: ["Find the proven adapter", "  Find   the proven adapter  "],
			recentContext: "Find the proven adapter",
		})
		expect(recallNeedFacets(need).map((value) => value.toLowerCase().replace(/\s+/g, " ").trim())).toEqual([
			"find the proven adapter",
		])
		expect(recallNeedFacets(need)).toHaveLength(1)
	})

	it("is stable across identical needs and changes for meaningful evidence", () => {
		const base = createRecallNeed({ objective: "Locate the offline check", evidence: ["old state"] })
		const identical = createRecallNeed({ objective: "Locate the offline check", evidence: ["ignored", "old state"] })
		const fresh = createRecallNeed({ objective: "Locate the offline check", evidence: ["new observable state"] })
		expect(recallNeedFingerprint(base)).toBe(recallNeedFingerprint(identical))
		expect(recallNeedFingerprint(base)).not.toBe(recallNeedFingerprint(fresh))
	})

	it("never requires domain-specific task or environment fields", () => {
		const need = createRecallNeed({ evidence: ["the service is unavailable"] })
		expect(need.taskScope).toBeUndefined()
		expect(need.environmentScope).toBeUndefined()
		expect(need.requestedKnowledge).toBeUndefined()
		expect(recallNeedFacets(need)).toEqual(["the service is unavailable"])
	})
})

describe("recall need change scheduling", () => {
	it("ignores an unchanged need", () => {
		expect(
			shouldEvaluateRecallNeed({ previousFingerprint: "same", fingerprint: "same", requestedAt: 1000, cooldownMs: 0 }),
		).toBe(false)
	})

	it("requests a new need immediately, and a changed one after the cooldown", () => {
		expect(shouldEvaluateRecallNeed({ fingerprint: "new", requestedAt: 1000, cooldownMs: 500 })).toBe(true)
		expect(
			shouldEvaluateRecallNeed({
				previousFingerprint: "old",
				fingerprint: "new",
				requestedAt: 1000,
				lastEvaluatedAt: 900,
				cooldownMs: 100,
			}),
		).toBe(true)
		expect(
			shouldEvaluateRecallNeed({
				previousFingerprint: "old",
				fingerprint: "new",
				requestedAt: 1000,
				lastEvaluatedAt: 950,
				cooldownMs: 101,
			}),
		).toBe(false)
	})
})
