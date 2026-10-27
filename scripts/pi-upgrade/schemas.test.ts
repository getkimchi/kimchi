import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { Impact } from "./schemas.ts"

const impact = (effortWhy: string) => ({
	verdict: { risk: "moderate", effort: "M", effortWhy, apiBreakage: "none", topHazard: "x" },
	breaking: [],
	keepDisabled: [],
	patchRework: [],
	freeWins: [],
	testTriage: [],
})

describe("Impact schema", () => {
	it("accepts a one-line verdict", () => {
		expect(Value.Check(Impact, impact("one patch conflict and a signature change"))).toBe(true)
	})

	it("rejects a paragraph-long verdict cell so the agent is asked to shorten it", () => {
		expect(Value.Check(Impact, impact("word ".repeat(60)))).toBe(false)
	})
})
