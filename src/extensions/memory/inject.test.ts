import { describe, expect, it } from "vitest"
import { DIGEST_MAX_FACTS, DIGEST_MAX_TOKENS } from "./config.js"
import { buildMemoryDigest, digestSection } from "./inject.js"

describe("buildMemoryDigest", () => {
	it("returns undefined when nothing clears the value bar — the normal outcome", () => {
		expect(buildMemoryDigest([])).toBeUndefined()
		expect(buildMemoryDigest([{ memory: "some fact", score: 0.1 }])).toBeUndefined()
		expect(buildMemoryDigest([{ memory: "", score: 0.9 }])).toBeUndefined()
	})

	it("keeps only above-threshold facts, ranked by score", () => {
		const result = buildMemoryDigest([
			{ memory: "weak fact", score: 0.19 },
			{ memory: "strong fact", score: 0.7 },
			{ memory: "mid fact", score: 0.5 },
		])
		expect(result).toBeDefined()
		if (!result) throw new Error("expected a digest")
		expect(result.composition.belowThreshold).toBe(1)
		expect(result.composition.facts).toBe(2)
		expect(result.text).toContain("strong fact")
		expect(result.text).toContain("mid fact")
		expect(result.text).not.toContain("weak fact")
	})

	it("enforces the top-N cap, keeping the highest-scored facts", () => {
		const hits = Array.from({ length: 10 }, (_, i) => ({
			memory: `fact ${i}`,
			score: 0.4 + i / 100, // fact 9 highest, fact 0 lowest
		}))
		const result = buildMemoryDigest(hits)
		expect(result).toBeDefined()
		if (!result) throw new Error("expected a digest")
		expect(result.composition.facts).toBe(DIGEST_MAX_FACTS)
		expect(result.composition.overCap).toBe(5)
		// The highest-scored facts win.
		expect(result.text).toContain("fact 9")
		expect(result.text).not.toContain("fact 0")
	})

	it("enforces the token budget by dropping the lowest-scored facts first", () => {
		// DIGEST_MAX_FACTS caps the field first, so the budget pressure must
		// come from fact size: 6 large facts → 5 kept (cap), then the budget
		// drops the lowest-scored ones until the section fits.
		const hits = Array.from({ length: 6 }, (_, i) => ({
			memory: `${"x".repeat(1600)} fact ${i}`,
			score: 0.5 + i / 1000,
		}))
		const result = buildMemoryDigest(hits)
		expect(result).toBeDefined()
		if (!result) throw new Error("expected a digest")
		expect(result.composition.overCap).toBe(1)
		expect(result.composition.tokensEstimated).toBeLessThanOrEqual(DIGEST_MAX_TOKENS)
		// Some facts survived and some were dropped for budget.
		expect(result.composition.facts).toBeGreaterThan(1)
		expect(result.composition.overBudget).toBeGreaterThan(0)
		// The highest-scored facts are still present.
		expect(result.text).toContain("fact 5")
		expect(result.text).not.toContain("fact 0")
	})

	it("hard-truncates a single fact that alone exceeds the budget", () => {
		const result = buildMemoryDigest([{ memory: "y".repeat(100_000), score: 0.9 }])
		expect(result).toBeDefined()
		if (!result) throw new Error("expected a digest")
		expect(result.composition.overBudget).toBe(1)
		expect(result.composition.tokensEstimated).toBeLessThanOrEqual(DIGEST_MAX_TOKENS)
	})

	it("produces byte-identical output for identical input (stable prefix)", () => {
		const hits = [
			{ memory: "prefers vim keybindings", score: 0.6 },
			{ memory: "uses pnpm", score: 0.55 },
		]
		const a = buildMemoryDigest(hits)
		const b = buildMemoryDigest([...hits])
		expect(a!.text).toBe(b!.text)
	})

	it("wraps the body in the stable memory section", () => {
		expect(digestSection("- a fact")).toBe("\n\n## User memory (from previous sessions, local-only)\n- a fact")
	})
})
