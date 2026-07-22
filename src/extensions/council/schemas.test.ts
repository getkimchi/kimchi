import { describe, expect, it } from "vitest"
import {
	type CouncilSchemaError,
	extractJsonObject,
	parseJudgeArtifact,
	parseReviewArtifact,
	stableFindingId,
} from "./schemas.js"

const rawFinding = {
	severity: "high" as const,
	statement: "The result is not verified",
	evidence_refs: ["artifact_1"],
	assumptions: ["Tests were not run"],
	suggested_check: "Run the focused test",
}

function independent(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schema_version: 1,
		role: "independent",
		decision: "revise",
		independent_solution: "Run the test, then report its result.",
		key_claims: ["The result needs verification."],
		assumptions: ["The focused test is available."],
		risks: ["An unverified result may be wrong."],
		required_checks: ["Run the focused test."],
		findings: [rawFinding],
		recommended_changes: ["Add verification evidence"],
		missing_evidence: ["Focused test output"],
		...overrides,
	})
}

describe("review artifacts", () => {
	it("parses strict role-specific output and assigns a stable finding id", () => {
		const first = parseReviewArtifact(independent(), "independent", ["artifact_1"])
		const second = parseReviewArtifact(independent(), "independent", ["artifact_1"])

		expect(first.role).toBe("independent")
		expect(first.findings[0].id).toMatch(/^finding_independent_[a-f0-9]{16}$/)
		expect(second.findings[0].id).toBe(first.findings[0].id)
	})

	it("keeps finding ids stable across harmless whitespace and set ordering", () => {
		const first = stableFindingId("critic", {
			...rawFinding,
			statement: "The   result is not verified",
			evidence_refs: ["b", "a"],
			assumptions: ["second", "first"],
		})
		const second = stableFindingId("critic", {
			...rawFinding,
			statement: " The result is not verified ",
			evidence_refs: ["a", "b"],
			assumptions: ["first", "second"],
		})

		expect(first).toBe(second)
	})

	it("rejects missing role fields, unknown fields, and unsupported evidence", () => {
		expect(() =>
			parseReviewArtifact(independent({ independent_solution: undefined }), "independent", ["artifact_1"]),
		).toThrowError(expect.objectContaining({ code: "invalid_shape" }))
		expect(() => parseReviewArtifact(independent({ surprise: true }), "independent", ["artifact_1"])).toThrowError(
			expect.objectContaining({ code: "invalid_shape" }),
		)
		expect(() => parseReviewArtifact(independent(), "independent", [])).toThrowError(
			expect.objectContaining({ code: "unsupported_reference" }),
		)
	})

	it("enforces critic and checker-specific contracts", () => {
		const critic = JSON.stringify({
			schema_version: 1,
			role: "critic",
			decision: "accept",
			challenged_assumptions: [],
			counterexamples: [],
			affected_claims: [],
			findings: [],
			recommended_changes: [],
			missing_evidence: [],
		})
		const checker = JSON.stringify({
			schema_version: 1,
			role: "checker",
			decision: "accept",
			requirement_checks: [{ requirement: "Tests pass", status: "satisfied", evidence_refs: ["test_1"] }],
			findings: [],
			recommended_changes: [],
			missing_evidence: [],
		})

		expect(parseReviewArtifact(critic, "critic", []).role).toBe("critic")
		expect(parseReviewArtifact(checker, "checker", ["test_1"]).role).toBe("checker")
		expect(() => parseReviewArtifact(critic, "checker", [])).toThrowError(
			expect.objectContaining({ code: "invalid_shape" }),
		)
	})
})

describe("deterministic JSON extraction", () => {
	it("extracts one fenced object and heals trailing commas and control characters", () => {
		const raw = '```json\n{"message":"line one\nline two", "values":[1,2,],}\n```'
		expect(JSON.parse(extractJsonObject(raw))).toEqual({ message: "line one\nline two", values: [1, 2] })
	})

	it("rejects ambiguous model output instead of guessing", () => {
		expect(() => extractJsonObject('{"a":1}\n{"b":2}')).toThrowError(
			expect.objectContaining<Partial<CouncilSchemaError>>({ code: "ambiguous_json" }),
		)
	})
})

describe("judge artifacts", () => {
	it("requires and validates one disposition for every finding", () => {
		const finding = parseReviewArtifact(independent(), "independent", ["artifact_1"]).findings[0]
		const judge = JSON.stringify({
			schema_version: 1,
			decision: "revise",
			dispositions: [
				{
					finding_id: finding.id,
					disposition: "upheld",
					rationale: "No test output is present.",
					evidence_refs: ["artifact_1"],
					revision_instruction: "Run and report the focused test.",
					required_check: null,
				},
			],
			revision_instructions: ["Run and report the focused test."],
			consensus: [],
			contradictions: [],
			partial_coverage: [],
			unique_insights: [],
			blind_spots: [],
			unsupported_claims: [],
			required_checks: ["Run the focused test."],
			agreement: "high",
		})

		expect(parseJudgeArtifact(judge, [finding], ["artifact_1"]).decision).toBe("revise")
		expect(() =>
			parseJudgeArtifact(JSON.stringify({ ...JSON.parse(judge), dispositions: [] }), [finding], ["artifact_1"]),
		).toThrowError(expect.objectContaining({ code: "missing_disposition" }))
	})

	it("rejects unknown findings, unknown fields, and disposition/decision conflicts", () => {
		const finding = parseReviewArtifact(independent(), "independent", ["artifact_1"]).findings[0]
		const base = {
			schema_version: 1,
			decision: "accept",
			dispositions: [
				{
					finding_id: finding.id,
					disposition: "resolved",
					rationale: "The test artifact proves the behavior.",
					evidence_refs: ["artifact_1"],
					revision_instruction: null,
					required_check: null,
				},
			],
			revision_instructions: [],
			consensus: [],
			contradictions: [],
			partial_coverage: [],
			unique_insights: [],
			blind_spots: [],
			unsupported_claims: [],
			required_checks: [],
			agreement: "high",
		}
		expect(() =>
			parseJudgeArtifact(
				JSON.stringify({
					...base,
					dispositions: [{ ...base.dispositions[0], finding_id: "finding_critic_0000000000000000" }],
				}),
				[finding],
				["artifact_1"],
			),
		).toThrowError(expect.objectContaining({ code: "unsupported_reference" }))
		expect(() => parseJudgeArtifact(JSON.stringify({ ...base, extra: true }), [finding], ["artifact_1"])).toThrowError(
			expect.objectContaining({ code: "invalid_shape" }),
		)
		expect(() =>
			parseJudgeArtifact(JSON.stringify({ ...base, decision: "revise" }), [finding], ["artifact_1"]),
		).toThrowError(expect.objectContaining({ code: "invalid_shape" }))
	})
})
