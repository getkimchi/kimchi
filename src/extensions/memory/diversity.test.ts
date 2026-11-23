import { describe, expect, it } from "vitest"
import { isNearDuplicate, memorySimilarity, selectDiverseFacts } from "./diversity.js"

const sixParaphrases = [
	{ memory: "project uses pnpm as package manager", score: 0.85 },
	{ memory: "this project uses pnpm as package manager", score: 0.8 },
	{ memory: "this project uses pnpm as its package manager", score: 0.83 },
	{ memory: "the project uses pnpm as package manager", score: 0.82 },
	{ memory: "project uses pnpm as the package manager", score: 0.81 },
	{ memory: "for this project use pnpm as package manager", score: 0.86 },
]

describe("memory diversity", () => {
	it("collapses paraphrase clusters and keeps the best representative", () => {
		const selected = selectDiverseFacts(sixParaphrases)
		expect(selected).toHaveLength(1)
		expect(selected[0]).toMatchObject({ memory: "for this project use pnpm as package manager", score: 0.86 })
	})

	it("keeps cause and correction as complementary evidence", () => {
		const selected = selectDiverseFacts([
			{ memory: "project uses pnpm as package manager" },
			{ memory: "project uses pnpm because it reduces disk usage" },
			{ memory: "project uses npm, not pnpm, for legacy builds" },
		])
		expect(selected).toHaveLength(3)
	})

	it("never collapses changed names, numeric values, or negation", () => {
		expect(
			isNearDuplicate("The project uses pnpm for package management", "The project uses npm for package management"),
		).toBe(false)
		expect(isNearDuplicate("Maximum batch size is 16", "Maximum batch size is 32")).toBe(false)
		expect(isNearDuplicate("Use pnpm for this project", "Do not use pnpm for this project")).toBe(false)
	})

	it("uses a stable lexical similarity and leaves disjoint contexts separate", () => {
		expect(memorySimilarity(" project  uses PNPM ", "project uses pnpm")).toBe(1)
		expect(
			selectDiverseFacts([
				{ memory: "project uses pnpm as package manager" },
				{ memory: "gateway embedding calls are rate limited" },
			]),
		).toHaveLength(2)
	})

	it("preserves fact IDs and applies deterministic MMR across diverse hits", () => {
		const first = { id: "fact-1", memory: "project uses pnpm as package manager", score: 0.8 }
		const second = { id: "fact-2", memory: "the fix is to pass --ignore-scripts", score: 0.91 }
		expect(selectDiverseFacts([first, second])).toEqual([second, first])
		expect(selectDiverseFacts([first, second])).toEqual([second, first])
	})

	it("drops exact-text and blank duplicates without deleting source evidence", () => {
		const input = [
			{ id: "old", memory: "a durable convention", score: 0.7 },
			{ id: "new", memory: "a durable convention", score: 0.9 },
			{ id: "blank", memory: "   ", score: 1 },
		]
		const selected = selectDiverseFacts(input)
		expect(selected).toEqual([{ id: "new", memory: "a durable convention", score: 0.9 }])
		expect(input).toHaveLength(3)
	})
})
