import { describe, expect, it } from "vitest"
import {
	GATE_REGISTRY,
	GateCoverageError,
	type GateVerdict,
	assertGateCoverage,
	flaggedVerdicts,
	getGateDefinition,
	getGateIdsForTurn,
	getGatesForTurn,
	hasBlockingFlag,
	renderGateGuidance,
	validateGateVerdict,
} from "./gate-registry.js"

function v(id: string, verdict: "pass" | "flag" | "omitted" = "pass"): GateVerdict {
	return {
		id: id as GateVerdict["id"],
		verdict,
		rationale: "rationale",
		evidence: "evidence",
	}
}

describe("gate-registry shape", () => {
	it("declares exactly 12 gates across 4 scopes", () => {
		const all = Object.values(GATE_REGISTRY)
		expect(all).toHaveLength(12)
		const byScope = new Map<string, number>()
		for (const g of all) byScope.set(g.scope, (byScope.get(g.scope) ?? 0) + 1)
		expect(byScope.get("plan")).toBe(3)
		expect(byScope.get("step")).toBe(3)
		expect(byScope.get("phase")).toBe(3)
		expect(byScope.get("ferment")).toBe(3)
	})

	it("every gate id matches its registry key", () => {
		for (const [key, def] of Object.entries(GATE_REGISTRY)) {
			expect(def.id).toBe(key)
		}
	})

	it("every gate has non-empty question and guidance", () => {
		for (const g of Object.values(GATE_REGISTRY)) {
			expect(g.question.length).toBeGreaterThan(10)
			expect(g.guidance.length).toBeGreaterThan(30)
		}
	})

	it("each ownerTurn maps to a consistent scope", () => {
		const turnScopeMap: Record<string, string> = {
			scope_ferment: "plan",
			complete_ferment_step: "step",
			complete_ferment_phase: "phase",
			complete_ferment: "ferment",
		}
		for (const g of Object.values(GATE_REGISTRY)) {
			expect(turnScopeMap[g.ownerTurn]).toBe(g.scope)
		}
	})
})

describe("getGatesForTurn", () => {
	it("returns the three plan gates for scope_ferment", () => {
		const gates = getGatesForTurn("scope_ferment")
		expect(gates.map((g) => g.id)).toEqual(["P1", "P2", "P3"])
	})

	it("returns the three step gates for complete_ferment_step", () => {
		expect(getGatesForTurn("complete_ferment_step").map((g) => g.id)).toEqual(["S1", "S2", "S3"])
	})

	it("returns the three phase gates for complete_ferment_phase", () => {
		expect(getGatesForTurn("complete_ferment_phase").map((g) => g.id)).toEqual(["F1", "F2", "F3"])
	})

	it("returns the three ferment gates for complete_ferment", () => {
		expect(getGatesForTurn("complete_ferment").map((g) => g.id)).toEqual(["C1", "C2", "C3"])
	})
})

describe("getGateIdsForTurn / getGateDefinition", () => {
	it("getGateIdsForTurn returns a set matching getGatesForTurn", () => {
		const ids = getGateIdsForTurn("complete_ferment_phase")
		expect([...ids].sort()).toEqual(["F1", "F2", "F3"])
	})

	it("getGateDefinition returns undefined for unknown ids", () => {
		expect(getGateDefinition("Z99")).toBeUndefined()
	})

	it("getGateDefinition round-trips a known id", () => {
		const def = getGateDefinition("S2")
		expect(def?.scope).toBe("step")
		expect(def?.ownerTurn).toBe("complete_ferment_step")
	})
})

describe("assertGateCoverage", () => {
	it("passes when all owned gates are present exactly once", () => {
		expect(() => assertGateCoverage([v("F1"), v("F2"), v("F3")], "complete_ferment_phase")).not.toThrow()
	})

	it("throws when a required gate is missing", () => {
		expect(() => assertGateCoverage([v("F1"), v("F2")], "complete_ferment_phase")).toThrow(GateCoverageError)
	})

	it("throws when an unknown gate id is provided", () => {
		expect(() =>
			assertGateCoverage([v("F1"), v("F2"), v("F3"), { ...v("Z99"), id: "Z99" as never }], "complete_ferment_phase"),
		).toThrow(/does not own/)
	})

	it("throws when a gate owned by another turn is provided", () => {
		expect(() => assertGateCoverage([v("S1"), v("S2"), v("S3"), v("F1")], "complete_ferment_step")).toThrow(
			/does not own/,
		)
	})

	it("throws on duplicate gate id", () => {
		expect(() => assertGateCoverage([v("F1"), v("F1"), v("F2"), v("F3")], "complete_ferment_phase")).toThrow(
			/duplicate/,
		)
	})
})

describe("validateGateVerdict", () => {
	it("accepts a well-formed verdict", () => {
		expect(validateGateVerdict(v("S1"))).toBeNull()
	})

	it("rejects unknown id", () => {
		expect(validateGateVerdict({ ...v("S1"), id: "Z99" as never })).toMatch(/unknown id/)
	})

	it("rejects invalid verdict value", () => {
		expect(validateGateVerdict({ ...v("S1"), verdict: "maybe" as never })).toMatch(/invalid verdict/)
	})

	it("rejects empty rationale", () => {
		expect(validateGateVerdict({ ...v("S1"), rationale: "   " })).toMatch(/rationale/)
	})

	it("rejects empty evidence", () => {
		expect(validateGateVerdict({ ...v("S1"), evidence: "" })).toMatch(/evidence/)
	})
})

describe("hasBlockingFlag / flaggedVerdicts", () => {
	it("hasBlockingFlag false when all pass or omitted", () => {
		expect(hasBlockingFlag([v("F1", "pass"), v("F2", "omitted"), v("F3", "pass")])).toBe(false)
	})

	it("hasBlockingFlag true when at least one flag", () => {
		expect(hasBlockingFlag([v("F1", "pass"), v("F2", "flag"), v("F3", "pass")])).toBe(true)
	})

	it("flaggedVerdicts returns only the flagged entries in input order", () => {
		const set = [v("F1", "pass"), v("F2", "flag"), v("F3", "flag")]
		const flagged = flaggedVerdicts(set)
		expect(flagged.map((f) => f.id)).toEqual(["F2", "F3"])
	})
})

describe("renderGateGuidance", () => {
	it("returns a markdown block listing every gate the turn owns", () => {
		const md = renderGateGuidance("complete_ferment_phase")
		expect(md).toContain("**F1**")
		expect(md).toContain("**F2**")
		expect(md).toContain("**F3**")
	})

	it("returns an empty string for a turn with no gates", () => {
		expect(renderGateGuidance("scope_ferment" as never).length).toBeGreaterThan(0)
	})
})
