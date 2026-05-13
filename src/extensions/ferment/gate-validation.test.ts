import { describe, expect, it } from "vitest"
import { validateGatesOrErr } from "./gate-validation.js"

const validPhaseGates = () => [
	{ id: "F1", verdict: "pass", rationale: "ok", evidence: "n/a" },
	{ id: "F2", verdict: "pass", rationale: "ok", evidence: "n/a" },
	{ id: "F3", verdict: "pass", rationale: "ok", evidence: "n/a" },
]

describe("validateGatesOrErr", () => {
	it("returns null when coverage is complete, shapes are valid, and no flags (block-on-flag policy)", () => {
		const result = validateGatesOrErr(validPhaseGates(), {
			turn: "complete_phase",
			flagPolicy: "block-on-flag",
		})
		expect(result).toBeNull()
	})

	it("returns a tool error when gates is undefined", () => {
		const result = validateGatesOrErr(undefined, { turn: "complete_phase", flagPolicy: "block-on-flag" })
		expect(result && "isError" in result && result.isError).toBe(true)
		expect(result?.content.map((c) => c.text).join("\n")).toContain("requires a 'gates' array")
	})

	it("returns a tool error when a required gate id is missing", () => {
		const result = validateGatesOrErr([{ id: "F1", verdict: "pass", rationale: "ok", evidence: "n/a" }], {
			turn: "complete_phase",
			flagPolicy: "block-on-flag",
		})
		expect(result && "isError" in result && result.isError).toBe(true)
		const text = result?.content.map((c) => c.text).join("\n") ?? ""
		expect(text).toContain("F2")
		expect(text).toContain("F3")
	})

	it("returns a tool error when a verdict is malformed (empty rationale)", () => {
		const malformed = [
			{ id: "F1", verdict: "pass", rationale: "", evidence: "n/a" },
			{ id: "F2", verdict: "pass", rationale: "ok", evidence: "n/a" },
			{ id: "F3", verdict: "pass", rationale: "ok", evidence: "n/a" },
		]
		const result = validateGatesOrErr(malformed, { turn: "complete_phase", flagPolicy: "block-on-flag" })
		expect(result && "isError" in result && result.isError).toBe(true)
		expect(result?.content.map((c) => c.text).join("\n")).toMatch(/rationale/)
	})

	it("under block-on-flag policy, a flag verdict triggers refusal with the custom message", () => {
		const flagged = [
			{ id: "F1", verdict: "flag", rationale: "step verifies via grep only", evidence: "step-1 used grep" },
			{ id: "F2", verdict: "pass", rationale: "ok", evidence: "n/a" },
			{ id: "F3", verdict: "pass", rationale: "ok", evidence: "n/a" },
		]
		const result = validateGatesOrErr(flagged, {
			turn: "complete_phase",
			flagPolicy: "block-on-flag",
			renderFlagError: (count, lines) => `custom refusal: ${count} flag(s)\n${lines}`,
		})
		expect(result && "isError" in result && result.isError).toBe(true)
		const text = result?.content.map((c) => c.text).join("\n") ?? ""
		expect(text).toContain("custom refusal: 1 flag(s)")
		expect(text).toContain("Gate F1")
		expect(text).toContain("step-1 used grep")
	})

	it("under coverage-only policy, a flag verdict does NOT refuse — returns null", () => {
		// complete_phase uses coverage-only because phase flags feed the
		// retry/escalation pipeline downstream, not an immediate refusal.
		const flagged = [
			{ id: "F1", verdict: "flag", rationale: "proxy verify", evidence: "step-1 grep" },
			{ id: "F2", verdict: "pass", rationale: "ok", evidence: "n/a" },
			{ id: "F3", verdict: "pass", rationale: "ok", evidence: "n/a" },
		]
		const result = validateGatesOrErr(flagged, { turn: "complete_phase", flagPolicy: "coverage-only" })
		expect(result).toBeNull()
	})

	it("under coverage-only policy, coverage failures STILL refuse", () => {
		const result = validateGatesOrErr([{ id: "F1", verdict: "pass", rationale: "ok", evidence: "n/a" }], {
			turn: "complete_phase",
			flagPolicy: "coverage-only",
		})
		expect(result && "isError" in result && result.isError).toBe(true)
	})

	it("falls back to a default refusal message when renderFlagError is not provided", () => {
		const flagged = [
			{ id: "F1", verdict: "flag", rationale: "x", evidence: "y" },
			{ id: "F2", verdict: "pass", rationale: "ok", evidence: "n/a" },
			{ id: "F3", verdict: "pass", rationale: "ok", evidence: "n/a" },
		]
		const result = validateGatesOrErr(flagged, { turn: "complete_phase", flagPolicy: "block-on-flag" })
		expect(result && "isError" in result && result.isError).toBe(true)
		expect(result?.content.map((c) => c.text).join("\n")).toContain("Call refused — agent self-flagged on 1 gate(s)")
	})
})
