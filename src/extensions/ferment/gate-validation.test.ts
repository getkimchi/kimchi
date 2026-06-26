import { validateToolArguments } from "@earendil-works/pi-ai"
import type { ToolCall } from "@earendil-works/pi-ai"
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { assertGateFieldsPresent, validateGatesOrErr } from "./gate-validation.js"
import { CompleteStepParams } from "./tool-schemas.js"

const validPhaseGates = () => [
	{ id: "F1", verdict: "pass", rationale: "ok", evidence: "n/a" },
	{ id: "F2", verdict: "pass", rationale: "ok", evidence: "n/a" },
	{ id: "F3", verdict: "pass", rationale: "ok", evidence: "n/a" },
]

describe("validateGatesOrErr", () => {
	it("returns null when coverage is complete, shapes are valid, and no flags (block-on-flag policy)", () => {
		const result = validateGatesOrErr(validPhaseGates(), {
			turn: "complete_ferment_phase",
			flagPolicy: "block-on-flag",
		})
		expect(result).toBeNull()
	})

	it("returns a tool error when gates is undefined", () => {
		const result = validateGatesOrErr(undefined, { turn: "complete_ferment_phase", flagPolicy: "block-on-flag" })
		expect(result && "isError" in result && result.isError).toBe(true)
		expect(result?.content.map((c) => c.text).join("\n")).toContain("requires a 'gates' array")
	})

	it("returns a tool error when a required gate id is missing", () => {
		const result = validateGatesOrErr([{ id: "F1", verdict: "pass", rationale: "ok", evidence: "n/a" }], {
			turn: "complete_ferment_phase",
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
		const result = validateGatesOrErr(malformed, { turn: "complete_ferment_phase", flagPolicy: "block-on-flag" })
		expect(result && "isError" in result && result.isError).toBe(true)
		expect(result?.content.map((c) => c.text).join("\n")).toMatch(/rationale/)
	})

	it("normalizes common S2 verification labels into canonical gate verdicts", () => {
		const gates = [
			{ id: "S1", verdict: "pass", rationale: "summary matches diff", evidence: "file.ts:1" },
			{ id: "S2", verdict: "smoke", rationale: "ran the artifact end-to-end", evidence: "browser smoke" },
			{ id: "S3", verdict: "pass", rationale: "edge case covered", evidence: "empty input" },
		]

		const result = validateGatesOrErr(gates, { turn: "complete_ferment_step", flagPolicy: "block-on-flag" })

		expect(result).toBeNull()
		expect(gates[1].verdict).toBe("pass")
	})

	it("normalizes proxy/sentinel S2 labels to flag so weak verification blocks", () => {
		const gates = [
			{ id: "S1", verdict: "pass", rationale: "summary matches diff", evidence: "file.ts:1" },
			{ id: "S2", verdict: "proxy", rationale: "grep only", evidence: "grep output" },
			{ id: "S3", verdict: "pass", rationale: "edge case covered", evidence: "empty input" },
		]

		const result = validateGatesOrErr(gates, { turn: "complete_ferment_step", flagPolicy: "block-on-flag" })

		expect(result && "isError" in result && result.isError).toBe(true)
		expect(gates[1].verdict).toBe("flag")
	})

	it("does not normalize verification labels outside complete_ferment_step S2", () => {
		const gates = [
			{ id: "F1", verdict: "smoke", rationale: "ran a smoke check", evidence: "browser smoke" },
			{ id: "F2", verdict: "pass", rationale: "ok", evidence: "n/a" },
			{ id: "F3", verdict: "pass", rationale: "ok", evidence: "n/a" },
		]

		const result = validateGatesOrErr(gates, { turn: "complete_ferment_phase", flagPolicy: "coverage-only" })

		expect(result && "isError" in result && result.isError).toBe(true)
		expect(result?.content.map((c) => c.text).join("\n")).toContain("invalid verdict: smoke")
		expect(gates[0].verdict).toBe("smoke")
	})

	it("under block-on-flag policy, a flag verdict triggers refusal with the custom message", () => {
		const flagged = [
			{ id: "F1", verdict: "flag", rationale: "step verifies via grep only", evidence: "step-1 used grep" },
			{ id: "F2", verdict: "pass", rationale: "ok", evidence: "n/a" },
			{ id: "F3", verdict: "pass", rationale: "ok", evidence: "n/a" },
		]
		const result = validateGatesOrErr(flagged, {
			turn: "complete_ferment_phase",
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
		// complete_ferment_phase uses coverage-only because phase flags feed the
		// retry/escalation pipeline downstream, not an immediate refusal.
		const flagged = [
			{ id: "F1", verdict: "flag", rationale: "proxy verify", evidence: "step-1 grep" },
			{ id: "F2", verdict: "pass", rationale: "ok", evidence: "n/a" },
			{ id: "F3", verdict: "pass", rationale: "ok", evidence: "n/a" },
		]
		const result = validateGatesOrErr(flagged, { turn: "complete_ferment_phase", flagPolicy: "coverage-only" })
		expect(result).toBeNull()
	})

	it("under coverage-only policy, coverage failures STILL refuse", () => {
		const result = validateGatesOrErr([{ id: "F1", verdict: "pass", rationale: "ok", evidence: "n/a" }], {
			turn: "complete_ferment_phase",
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
		const result = validateGatesOrErr(flagged, { turn: "complete_ferment_phase", flagPolicy: "block-on-flag" })
		expect(result && "isError" in result && result.isError).toBe(true)
		expect(result?.content.map((c) => c.text).join("\n")).toContain("Call refused — agent self-flagged on 1 gate(s)")
	})
})

describe("assertGateFieldsPresent", () => {
	it("passes through args when all gate fields are present", () => {
		const args = {
			ferment_id: "f1",
			gates: [
				{ id: "P1", verdict: "pass", rationale: "ok", evidence: "file.ts:1" },
				{ id: "P2", verdict: "omitted", rationale: "single phase", evidence: "n/a" },
			],
		}
		expect(assertGateFieldsPresent(args)).toBe(args)
	})

	it("throws when evidence is missing from a gate", () => {
		const args = {
			gates: [{ id: "P1", verdict: "pass", rationale: "ok" }],
		}
		expect(() => assertGateFieldsPresent(args)).toThrow(/P1: missing "evidence"/)
	})

	it("throws when rationale is missing from a gate", () => {
		const args = {
			gates: [{ id: "P1", verdict: "pass", evidence: "file.ts:1" }],
		}
		expect(() => assertGateFieldsPresent(args)).toThrow(/P1: missing "rationale"/)
	})

	it("throws when both evidence and rationale are missing", () => {
		const args = {
			gates: [{ id: "P1", verdict: "pass" }],
		}
		expect(() => assertGateFieldsPresent(args)).toThrow(/P1: missing "evidence"/)
		expect(() => assertGateFieldsPresent(args)).toThrow(/P1: missing "rationale"/)
	})

	it("throws when verdict is missing (with id present)", () => {
		const args = {
			gates: [{ id: "P1", rationale: "ok", evidence: "file.ts:1" }],
		}
		expect(() => assertGateFieldsPresent(args)).toThrow(/P1: missing "verdict"/)
	})

	it("throws when id is missing (with verdict present)", () => {
		const args = {
			gates: [{ verdict: "pass", rationale: "ok", evidence: "file.ts:1" }],
		}
		expect(() => assertGateFieldsPresent(args)).toThrow(/gates\[0\]: missing "id"/)
	})

	it("rejects empty-string evidence", () => {
		const args = {
			gates: [{ id: "P1", verdict: "pass", rationale: "ok", evidence: "" }],
		}
		expect(() => assertGateFieldsPresent(args)).toThrow(/P1: missing "evidence"/)
	})

	it("rejects whitespace-only evidence", () => {
		const args = {
			gates: [{ id: "P1", verdict: "pass", rationale: "ok", evidence: "   " }],
		}
		expect(() => assertGateFieldsPresent(args)).toThrow(/P1: missing "evidence"/)
	})

	it("reports all gates with missing fields, not just the first", () => {
		const args = {
			gates: [
				{ id: "P1", verdict: "pass" },
				{ id: "P2", verdict: "omitted", rationale: "single phase" },
				{ id: "P3", verdict: "pass", rationale: "criteria", evidence: "file.ts" },
			],
		}
		try {
			assertGateFieldsPresent(args)
			expect.fail("should have thrown")
		} catch (e: unknown) {
			const msg = (e as Error).message
			expect(msg).toContain('P1: missing "evidence"')
			expect(msg).toContain('P1: missing "rationale"')
			expect(msg).toContain('P2: missing "evidence"')
			expect(msg).not.toContain("P3")
		}
	})

	it("uses positional index when gate has no id", () => {
		const args = {
			gates: [{ verdict: "pass", rationale: "ok" }],
		}
		expect(() => assertGateFieldsPresent(args)).toThrow(/gates\[0\]: missing "evidence"/)
		expect(() => assertGateFieldsPresent(args)).toThrow(/gates\[0\]: missing "id"/)
	})

	it("passes through args without gates unchanged", () => {
		const args = { ferment_id: "f1", summary: "done" }
		expect(assertGateFieldsPresent(args)).toEqual({ ferment_id: "f1", summary: "done" })
	})

	it("handles null/undefined input safely", () => {
		expect(assertGateFieldsPresent(null)).toBeNull()
		expect(assertGateFieldsPresent(undefined)).toBeUndefined()
	})

	it("rejects null/non-object/array gate entries", () => {
		const args = {
			gates: [null, "string", { id: "P1", verdict: "pass", rationale: "ok", evidence: "file.ts" }],
		}
		expect(() => assertGateFieldsPresent(args)).toThrow(/invalid gate object/)
	})

	it("rejects an array entry inside the gates array", () => {
		const args = {
			gates: [["nested"]],
		}
		expect(() => assertGateFieldsPresent(args)).toThrow(/invalid gate object/)
	})

	it("includes the fix instruction in the error message", () => {
		const args = {
			gates: [{ id: "P1", verdict: "pass" }],
		}
		expect(() => assertGateFieldsPresent(args)).toThrow(
			/Every gate object requires \{id, verdict, rationale, evidence\}/,
		)
	})
})

describe("pi-ai validation patch regressions", () => {
	it("coerces JSON-encoded string to array", () => {
		const tool = {
			name: "test-array",
			description: "test array coercion",
			parameters: Type.Object({ items: Type.Array(Type.String()) }),
			execute: () => {},
		}
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "test-array-call",
			name: "test-array",
			arguments: { items: '["a","b"]' },
		} as ToolCall)
		expect(args.items).toEqual(["a", "b"])
	})

	it("coerces JSON-encoded string to object", () => {
		const tool = {
			name: "test-object",
			description: "test object coercion",
			parameters: Type.Object({ config: Type.Object({ enabled: Type.Boolean() }) }),
			execute: () => {},
		}
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "test-object-call",
			name: "test-object",
			arguments: { config: '{"enabled":true}' },
		} as ToolCall)
		expect(args.config).toEqual({ enabled: true })
	})

	it("does not throw SyntaxError for already-parsed ferment args", () => {
		const tool = {
			name: "complete_ferment_step",
			description: "test ferment args",
			parameters: CompleteStepParams,
			execute: () => {},
		}
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "complete-step-call",
				name: "complete_ferment_step",
				arguments: {
					ferment_id: "ferment-1",
					phase_id: "phase-1",
					step_id: "step-1",
					gates: [{ id: "S1", verdict: "pass", rationale: "ok", evidence: "test" }],
				},
			} as ToolCall),
		).not.toThrow(SyntaxError)
	})
})
