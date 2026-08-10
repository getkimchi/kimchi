import { describe, expect, it } from "vitest"
import {
	CombinedFusionSchema,
	CouncilAnswerSchema,
	type CouncilSchemaError,
	extractJsonObject,
	FusionAnalysisSchema,
	parseCombinedFusionArtifact,
	parseCouncilAnswer,
	parseFusionAnalysisArtifact,
} from "./schemas.js"

const validPatch = { operations: [{ op: "create" as const, path: "a.txt", content: "hi" }] }

describe("fusion schemas", () => {
	it("keeps only catalog validation IDs and drops the rest", () => {
		const analysis = {
			consensus: ["shared"],
			contradictions: [],
			partial_coverage: [],
			unique_insights: [],
			blind_spots: [],
			required_checks: ["package.test"],
		}
		expect(parseFusionAnalysisArtifact(JSON.stringify(analysis), ["package.test"]).required_checks).toEqual([
			"package.test",
		])
		expect(parseFusionAnalysisArtifact(JSON.stringify(analysis), ["package.typecheck"]).required_checks).toEqual([])
		expect(FusionAnalysisSchema.safeParse({ ...analysis, required_checks: [] }).success).toBe(true)
	})

	it("tolerates oversized buckets, missing buckets, unknown keys, over-long strings, and 5 required_checks", () => {
		const longString = "x".repeat(5000)
		const rich = {
			consensus: Array.from({ length: 25 }, (_, index) => `point ${index}: ${longString}`),
			contradictions: [],
			partial_coverage: [],
			unique_insights: [],
			// blind_spots omitted entirely
			required_checks: ["a", "b", "c", "d", "e"],
			unknown_extra_key: "should be dropped silently",
		}
		const parsed = parseFusionAnalysisArtifact(JSON.stringify(rich), ["a", "b", "c", "d", "e"])
		expect(parsed.consensus).toHaveLength(20)
		expect(parsed.consensus[0]?.length).toBeLessThanOrEqual(2048)
		expect(parsed.blind_spots).toEqual([])
		expect(parsed.required_checks).toEqual(["a", "b", "c"])
		expect((parsed as Record<string, unknown>).unknown_extra_key).toBeUndefined()
	})

	it("drops all-unknown required_checks down to an empty list instead of failing", () => {
		const analysis = {
			consensus: [],
			contradictions: [],
			partial_coverage: [],
			unique_insights: [],
			blind_spots: [],
			required_checks: ["nonexistent.check"],
		}
		expect(parseFusionAnalysisArtifact(JSON.stringify(analysis), ["package.test"]).required_checks).toEqual([])
	})

	it("still requires a strictly valid patch inside a combined fusion response", () => {
		const combined = {
			analysis: {
				consensus: [],
				contradictions: [],
				partial_coverage: [],
				unique_insights: [],
				blind_spots: [],
				required_checks: [],
			},
			patch: validPatch,
			extra_top_level_key: "ignored",
		}
		expect(parseCombinedFusionArtifact(JSON.stringify(combined)).patch).toEqual(validPatch)
		expect(CombinedFusionSchema.safeParse({ ...combined, patch: { operations: [{ op: "bogus" }] } }).success).toBe(
			false,
		)
	})

	it("round-trips a council answer and rejects an empty or malformed one", () => {
		expect(parseCouncilAnswer(JSON.stringify({ answer: "The recommended approach is X." }))).toEqual({
			answer: "The recommended approach is X.",
		})
		expect(CouncilAnswerSchema.safeParse({ answer: "" }).success).toBe(false)
		expect(CouncilAnswerSchema.safeParse({}).success).toBe(false)
		expect(CouncilAnswerSchema.safeParse({ answer: "ok", extra: "field" }).success).toBe(false)
		expect(() => parseCouncilAnswer("not json")).toThrowError(
			expect.objectContaining<Partial<CouncilSchemaError>>({ code: "missing_json" }),
		)
	})

	it("extracts one fenced object and rejects ambiguous output", () => {
		const raw = '```json\n{"message":"line one\nline two", "values":[1,2,],}\n```'
		expect(JSON.parse(extractJsonObject(raw))).toEqual({ message: "line one\nline two", values: [1, 2] })
		expect(() => extractJsonObject('{"a":1}\n{"b":2}')).toThrowError(
			expect.objectContaining<Partial<CouncilSchemaError>>({ code: "ambiguous_json" }),
		)
	})
})
