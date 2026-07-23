import { describe, expect, it } from "vitest"
import {
	type CouncilSchemaError,
	extractJsonObject,
	parseFinalCheckArtifact,
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
		const requirementId = "requirement_0123456789abcdef"
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
			requirement_checks: [{ requirement: requirementId, status: "satisfied", evidence_refs: ["test_1"] }],
			findings: [],
			recommended_changes: [],
			missing_evidence: [],
		})

		expect(parseReviewArtifact(critic, "critic", []).role).toBe("critic")
		expect(parseReviewArtifact(checker, "checker", ["test_1"], [requirementId]).role).toBe("checker")
		expect(() => parseReviewArtifact(critic, "checker", [])).toThrowError(
			expect.objectContaining({ code: "invalid_shape" }),
		)
	})

	it("requires the checker to cover every supplied requirement exactly once", () => {
		const first = "requirement_0123456789abcdef"
		const second = "requirement_fedcba9876543210"
		const checker = (requirementChecks: unknown[]) =>
			JSON.stringify({
				schema_version: 1,
				role: "checker",
				decision: "accept",
				requirement_checks: requirementChecks,
				findings: [],
				recommended_changes: [],
				missing_evidence: [],
			})
		const check = (requirement: string) => ({ requirement, status: "satisfied", evidence_refs: ["test_1"] })

		expect(() => parseReviewArtifact(checker([check(first)]), "checker", ["test_1"], [first, second])).toThrowError(
			/Requirement checks are missing/,
		)
		expect(() =>
			parseReviewArtifact(checker([check(first), check(first)]), "checker", ["test_1"], [first, second]),
		).toThrowError(/duplicated/)
		expect(() =>
			parseReviewArtifact(
				checker([check(first), check("requirement_unknown")]),
				"checker",
				["test_1"],
				[first, second],
			),
		).toThrowError(expect.objectContaining({ code: "unsupported_reference" }))
		expect(
			parseReviewArtifact(checker([check(first), check(second)]), "checker", ["test_1"], [first, second]),
		).toMatchObject({
			role: "checker",
			requirement_checks: [{ requirement: first }, { requirement: second }],
		})
	})

	it("bounds reviewer findings and required checks", () => {
		expect(() =>
			parseReviewArtifact(independent({ findings: Array.from({ length: 9 }, () => rawFinding) }), "independent", [
				"artifact_1",
			]),
		).toThrowError(expect.objectContaining({ code: "invalid_shape" }))
		expect(() =>
			parseReviewArtifact(
				independent({ required_checks: Array.from({ length: 6 }, (_, index) => `check ${index}`) }),
				"independent",
				["artifact_1"],
			),
		).toThrowError(expect.objectContaining({ code: "invalid_shape" }))
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

	it("accepts only known deterministic validation IDs when a catalog is supplied", () => {
		const judge = {
			schema_version: 1,
			decision: "accept",
			dispositions: [],
			revision_instructions: [],
			consensus: [],
			contradictions: [],
			partial_coverage: [],
			unique_insights: [],
			blind_spots: [],
			unsupported_claims: [],
			required_checks: ["package.test"],
			agreement: "high",
		}

		expect(parseJudgeArtifact(JSON.stringify(judge), [], [], ["package.test"]).required_checks).toEqual([
			"package.test",
		])
		expect(() => parseJudgeArtifact(JSON.stringify(judge), [], [], ["package.typecheck"])).toThrowError(
			expect.objectContaining({ code: "unsupported_reference" }),
		)
		expect(() =>
			parseJudgeArtifact(JSON.stringify({ ...judge, required_checks: [] }), [], [], ["package.test"]),
		).toThrowError(expect.objectContaining({ code: "invalid_shape" }))
	})
})

describe("final checker artifacts", () => {
	const patchSha256 = "a".repeat(64)
	const obligations = ["finding_1", "required_check_1"]
	const allowedEvidence = ["artifact_candidate_patch", "artifact_candidate_validation"]
	const output = {
		schema_version: 1,
		role: "checker",
		decision: "accept",
		patch_sha256: patchSha256,
		resolutions: obligations.map((obligation_id, index) => ({
			obligation_id,
			status: "resolved",
			rationale: "The candidate addresses this obligation.",
			evidence_refs: [allowedEvidence[index]],
		})),
	}

	it("requires the exact patch hash, one resolution per obligation, and valid evidence", () => {
		const parsed = parseFinalCheckArtifact(JSON.stringify(output), patchSha256, obligations, allowedEvidence)

		expect(parsed.patch_sha256).toBe(patchSha256)
		expect(parsed.resolutions.map(({ obligation_id }) => obligation_id)).toEqual(obligations)
	})

	it("rejects patch drift and incomplete, duplicate, or unsupported resolutions", () => {
		expect(() =>
			parseFinalCheckArtifact(JSON.stringify(output), "b".repeat(64), obligations, allowedEvidence),
		).toThrowError(expect.objectContaining({ code: "invalid_shape" }))
		expect(() =>
			parseFinalCheckArtifact(
				JSON.stringify({ ...output, resolutions: output.resolutions.slice(0, 1) }),
				patchSha256,
				obligations,
				allowedEvidence,
			),
		).toThrowError(expect.objectContaining({ code: "invalid_shape" }))
		expect(() =>
			parseFinalCheckArtifact(
				JSON.stringify({ ...output, resolutions: [output.resolutions[0], output.resolutions[0]] }),
				patchSha256,
				obligations,
				allowedEvidence,
			),
		).toThrowError(expect.objectContaining({ code: "invalid_shape" }))
		expect(() =>
			parseFinalCheckArtifact(
				JSON.stringify({
					...output,
					resolutions: [{ ...output.resolutions[0], evidence_refs: ["artifact_unknown"] }, output.resolutions[1]],
				}),
				patchSha256,
				obligations,
				allowedEvidence,
			),
		).toThrowError(expect.objectContaining({ code: "unsupported_reference" }))
	})

	it("requires evidence for every resolved obligation", () => {
		expect(() =>
			parseFinalCheckArtifact(
				JSON.stringify({
					...output,
					resolutions: [{ ...output.resolutions[0], evidence_refs: [] }, output.resolutions[1]],
				}),
				patchSha256,
				obligations,
				allowedEvidence,
			),
		).toThrowError(expect.objectContaining({ code: "invalid_shape" }))
	})

	it("accepts if and only if every obligation is resolved", () => {
		const unresolved = {
			...output,
			decision: "reject",
			resolutions: [{ ...output.resolutions[0], status: "unresolved", evidence_refs: [] }, output.resolutions[1]],
		}
		expect(
			parseFinalCheckArtifact(JSON.stringify(unresolved), patchSha256, obligations, allowedEvidence).decision,
		).toBe("reject")
		const evidenceGap = {
			...unresolved,
			decision: "needs_evidence",
			resolutions: [{ ...output.resolutions[0], status: "needs_evidence" }, output.resolutions[1]],
		}
		expect(
			parseFinalCheckArtifact(JSON.stringify(evidenceGap), patchSha256, obligations, allowedEvidence).decision,
		).toBe("needs_evidence")
		expect(() =>
			parseFinalCheckArtifact(
				JSON.stringify({ ...unresolved, decision: "accept" }),
				patchSha256,
				obligations,
				allowedEvidence,
			),
		).toThrowError(expect.objectContaining({ code: "invalid_shape" }))
		for (const decision of ["reject", "needs_evidence"]) {
			expect(() =>
				parseFinalCheckArtifact(JSON.stringify({ ...output, decision }), patchSha256, obligations, allowedEvidence),
			).toThrowError(expect.objectContaining({ code: "invalid_shape" }))
		}
	})
})
