import { describe, expect, it } from "vitest"
import { mergeScopedResults } from "./scoped-searcher.js"

describe("mergeScopedResults", () => {
	it("merges by score descending across stores", () => {
		const personal = [{ memory: "p1", score: 0.5, scope: "personal" as const }]
		const project = [
			{ memory: "pr1", score: 0.7, scope: "project" as const },
			{ memory: "pr2", score: 0.3, scope: "project" as const },
		]
		const merged = mergeScopedResults(personal, project, 8)
		expect(merged.map((m) => m.memory)).toEqual(["pr1", "p1", "pr2"])
	})

	it("trims to topK keeping the highest scores regardless of store", () => {
		const personal = Array.from({ length: 5 }, (_, i) => ({
			memory: `p${i}`,
			score: 0.5 - i * 0.01,
			scope: "personal" as const,
		}))
		const project = Array.from({ length: 5 }, (_, i) => ({
			memory: `q${i}`,
			score: 0.4 - i * 0.01,
			scope: "project" as const,
		}))
		const merged = mergeScopedResults(personal, project, 3)
		expect(merged).toHaveLength(3)
		expect(merged.map((m) => m.memory)).toEqual(["p0", "p1", "p2"])
	})

	it("handles empty stores on either side", () => {
		expect(mergeScopedResults([], [], 8)).toEqual([])
		expect(mergeScopedResults([{ memory: "only", score: 0.5, scope: "personal" }], [], 8)).toHaveLength(1)
	})
})
