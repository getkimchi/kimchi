import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	describeJudgeModel,
	type GraderSubagentResult,
	isGrade,
	type JudgeApiResult,
	type JudgeJourneyGradeInput,
	type JudgePhaseInput,
	judgeJourneyGrade,
	judgeJourneyGradeViaSubagent,
	judgePhaseGrade,
	judgePhaseGradeViaSubagent,
} from "./judge.js"
import { captureJudgeContext } from "./state.js"

describe("isGrade", () => {
	it("accepts the five valid letters", () => {
		for (const g of ["A", "B", "C", "D", "F"]) expect(isGrade(g)).toBe(true)
	})

	it("rejects lowercase, neighbouring letters, numbers, and non-strings", () => {
		for (const x of ["a", "E", "G", "", "AA", 1, null, undefined, {}]) expect(isGrade(x)).toBe(false)
	})
})

function makeInput(overrides: Partial<JudgeJourneyGradeInput> = {}): JudgeJourneyGradeInput {
	return {
		fermentName: "Test Ferment",
		goal: "Ship the feature.",
		successCriteria: "Tests pass; lint clean.",
		finalSummary: "Implemented retry logic with tests.",
		phases: [
			{
				name: "Phase 1",
				goal: "Build retry plumbing.",
				status: "completed",
				gateVerdicts: [
					{ id: "F1", verdict: "pass", rationale: "step-1 used smoke" },
					{ id: "F2", verdict: "pass", rationale: "feature.ts:1-40 delivers retry" },
					{ id: "F3", verdict: "pass", rationale: "Nothing deferred" },
				],
			},
		],
		fermentGates: [
			{ id: "C1", verdict: "pass", rationale: "tests pass, lint clean" },
			{ id: "C2", verdict: "pass", rationale: "no deferrals" },
			{ id: "C3", verdict: "pass", rationale: "smoke test exercised the retry path" },
		],
		totalDiff: { available: true, filesChanged: "feature.ts\nfeature.test.ts", diffSnippet: "+retry logic" },
		...overrides,
	}
}

describe("judgeJourneyGrade", () => {
	function ok(text: string): JudgeApiResult {
		return { ok: true, text }
	}

	it("returns the parsed grade + rationale on a clean response", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"B","rationale":"Goal met but coverage is thin."}'))
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("B")
		expect(result.rationale).toContain("coverage is thin")
	})

	it("strips markdown fences from the model output", async () => {
		const apiCall = vi.fn(async () => ok('```json\n{"grade":"A","rationale":"clean"}\n```'))
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("A")
	})

	it("returns invalid_grade when the model returns a non-letter", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"excellent","rationale":"x"}'))
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.reason).toBe("invalid_grade")
		expect(result.detail).toContain("excellent")
	})

	it("returns unparseable when the model returns non-JSON garbage", async () => {
		const apiCall = vi.fn(async () => ok("I think this work is pretty good honestly"))
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.reason).toBe("unparseable")
	})

	it("propagates judge_unavailable when the API call fails", async () => {
		const apiCall = vi.fn(async (): Promise<JudgeApiResult> => ({ ok: false, reason: "no_auth" }))
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(apiCall).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.reason).toBe("no_auth")
	})

	it("retries empty_response before accepting a later grade", async () => {
		const apiCall = vi
			.fn<(_sys: string, _msg: string, _maxTokens?: number) => Promise<JudgeApiResult>>()
			.mockResolvedValueOnce({ ok: false, reason: "empty_response" })
			.mockResolvedValueOnce({ ok: false, reason: "empty_response" })
			.mockResolvedValueOnce(ok('{"grade":"B","rationale":"Recovered on retry."}'))

		const result = await judgeJourneyGrade(makeInput(), apiCall)

		expect(apiCall).toHaveBeenCalledTimes(3)
		expect(apiCall.mock.calls.map((call) => call.length)).toEqual([2, 2, 2])
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("B")
		expect(result.rationale).toContain("Recovered")
	})

	it("returns empty_response after the retry budget is exhausted", async () => {
		const apiCall = vi.fn(
			async (): Promise<JudgeApiResult> => ({
				ok: false,
				reason: "empty_response",
			}),
		)

		const result = await judgeJourneyGrade(makeInput(), apiCall)

		expect(apiCall).toHaveBeenCalledTimes(3)
		expect(apiCall.mock.calls.map((call) => call.length)).toEqual([2, 2, 2])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.reason).toBe("empty_response")
		expect(result.detail).toContain("after 3 attempts")
	})

	it("includes per-phase F-gate verdicts in the prompt the judge sees", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"A","rationale":"x"}')
		})
		await judgeJourneyGrade(makeInput(), apiCall)
		expect(captured).toContain("F1 (pass): step-1 used smoke")
		expect(captured).toContain("F2 (pass): feature.ts:1-40 delivers retry")
		expect(captured).toContain("C3 (pass): smoke test exercised the retry path")
	})

	it("renders the intent charter into the prompt above the criteria", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"A","rationale":"x"}')
		})
		await judgeJourneyGrade(
			makeInput({
				charter: {
					intent: "Recreate the Tahoe desktop",
					wowFactor: "Feels like the real OS",
					demoScript: "Boot the page; Finder opens",
				},
			}),
			apiCall,
		)
		expect(captured).toContain("INTENT CHARTER")
		expect(captured).toContain("Recreate the Tahoe desktop")
		expect(captured).toContain("Feels like the real OS")
		expect(captured).toContain("Boot the page; Finder opens")
	})

	it("omits the charter section when the ferment predates charters", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"A","rationale":"x"}')
		})
		await judgeJourneyGrade(makeInput(), apiCall)
		expect(captured).not.toContain("INTENT CHARTER")
	})

	it("renders '(no verdicts on file)' for phases missing review-evidence", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"C","rationale":"missing audit trail"}')
		})
		await judgeJourneyGrade(
			makeInput({
				phases: [{ name: "Legacy Phase", goal: "x", status: "completed" }],
			}),
			apiCall,
		)
		expect(captured).toContain("(no verdicts on file)")
	})

	it("includes the total diff in the prompt when available", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"A","rationale":"x"}')
		})
		await judgeJourneyGrade(makeInput(), apiCall)
		expect(captured).toContain("Files changed:\nfeature.ts")
		expect(captured).toContain("+retry logic")
	})

	it("notes when no diff is available", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"C","rationale":"x"}')
		})
		await judgeJourneyGrade(makeInput({ totalDiff: { available: false } }), apiCall)
		expect(captured).toContain("No diff available")
	})

	it("includes agent-provided execution evidence in the prompt", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"A","rationale":"x"}')
		})
		await judgeJourneyGrade(
			makeInput({
				evidence: "$ pytest -q\n5 passed\n$ cat output.txt\nresult=ok",
			}),
			apiCall,
		)
		expect(captured).toContain("EXECUTION EVIDENCE")
		expect(captured).toContain("5 passed")
	})

	it("includes execution evidence even when no diff is available", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"B","rationale":"x"}')
		})
		await judgeJourneyGrade(
			makeInput({
				totalDiff: { available: false },
				evidence: "$ stockfish analysis\nbest move: g2g4 (#+1)",
			}),
			apiCall,
		)
		expect(captured).toContain("No diff available")
		expect(captured).toContain("EXECUTION EVIDENCE")
		expect(captured).toContain("g2g4")
	})

	it("omits the evidence section when evidence is empty", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"A","rationale":"x"}')
		})
		await judgeJourneyGrade(makeInput({ evidence: "" }), apiCall)
		expect(captured).not.toContain("EXECUTION EVIDENCE")
	})

	// ── recommendations parsing ──────────────────────────────────────────────

	it("returns parsed recommendations on a clean B-grade response", async () => {
		const apiCall = vi.fn(async () =>
			ok(
				'{"grade":"B","rationale":"thin coverage","recommendations":["Add edge-case test for empty input — untested path could NPE. Fix: add test. Evidence: test passes."]}',
			),
		)
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("B")
		expect(result.recommendations).toHaveLength(1)
		expect(result.recommendations[0]).toContain("Add edge-case test")
	})

	it("defaults recommendations to [] when the field is missing", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"clean"}'))
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.recommendations).toEqual([])
	})

	it("defaults recommendations to [] when the field is null", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"clean","recommendations":null}'))
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.recommendations).toEqual([])
	})

	it("coerces a single-string recommendations field to [string]", async () => {
		const apiCall = vi.fn(async () =>
			ok('{"grade":"C","rationale":"weak","recommendations":"Fix the N+1 query in listUsers."}'),
		)
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.recommendations).toEqual(["Fix the N+1 query in listUsers."])
	})

	it("filters empty recommendation strings", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"D","rationale":"gaps","recommendations":["real fix","","   "]}'))
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.recommendations).toEqual(["real fix"])
	})

	it("truncates oversized recommendation arrays and strings", async () => {
		const longString = "x".repeat(1000)
		const many = Array.from({ length: 50 }, () => longString)
		const apiCall = vi.fn(async () => ok(`{"grade":"D","rationale":"gaps","recommendations":${JSON.stringify(many)}}`))
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.recommendations).toHaveLength(20)
		expect(result.recommendations[0].length).toBe(600)
	})

	it("returns normalized charter verdicts when the grader provides them", async () => {
		const apiCall = vi.fn(async () =>
			ok(
				'{"grade":"B","rationale":"shell works","recommendations":[],"charter_verdicts":[' +
					'{"clause":"recreate the Tahoe desktop","status":"unmet","evidence":"only a bootable shell replica exists"},' +
					'{"clause":"feels real","status":"met","evidence":"window chrome matches references"},' +
					'{"clause":"x","status":"bogus","evidence":"y"},' +
					'{"clause":"","status":"met","evidence":"y"},' +
					"42 ]}",
			),
		)
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.charterVerdicts).toEqual([
			{ clause: "recreate the Tahoe desktop", status: "unmet", evidence: "only a bootable shell replica exists" },
			{ clause: "feels real", status: "met", evidence: "window chrome matches references" },
		])
	})

	it("omits charterVerdicts when the grader provides none", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"clean"}'))
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.charterVerdicts).toBeUndefined()
	})

	it("caps charter verdict arrays and sizes to bound the persisted payload", async () => {
		const many = Array.from({ length: 30 }, (_, i) => ({
			clause: `clause ${i} ${"x".repeat(500)}`,
			status: "met",
			evidence: `evidence ${i} ${"y".repeat(800)}`,
		}))
		const apiCall = vi.fn(async () => ok(`{"grade":"A","rationale":"x","charter_verdicts":${JSON.stringify(many)}}`))
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.charterVerdicts).toHaveLength(12)
		expect(result.charterVerdicts?.[0]?.clause.length).toBe(200)
		expect(result.charterVerdicts?.[0]?.evidence.length).toBe(400)
	})

	it("retries when a charter exists but charter_verdicts are missing, then accepts them", async () => {
		const apiCall = vi
			.fn()
			.mockResolvedValueOnce(ok('{"grade":"A","rationale":"clean"}'))
			.mockResolvedValueOnce(
				ok(
					'{"grade":"A","rationale":"clean","charter_verdicts":[{"clause":"recreate Tahoe","status":"met","evidence":"shell recreated"}]}',
				),
			)
		const result = await judgeJourneyGrade(makeInput({ charter: { intent: "recreate Tahoe" } }), apiCall)
		expect(apiCall).toHaveBeenCalledTimes(2)
		// The retry names the omission so the judge knows what to fix — a bare
		// repeated prompt tends to repeat the same failure mode (PR #989 review).
		const messages = apiCall.mock.calls.map((call) => call[1])
		expect(messages[0]).not.toContain("REMINDER")
		expect(messages[1]).toContain("REMINDER")
		expect(messages[1]).toContain("charter_verdicts")
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.charterVerdicts).toEqual([{ clause: "recreate Tahoe", status: "met", evidence: "shell recreated" }])
	})

	it("soft-degrades after max attempts when verdicts never arrive (grade still lands)", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"clean"}'))
		const result = await judgeJourneyGrade(makeInput({ charter: { intent: "recreate Tahoe" } }), apiCall)
		expect(apiCall).toHaveBeenCalledTimes(3)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.charterVerdicts).toBeUndefined()
	})

	it("does not retry for missing verdicts when no charter exists", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"clean"}'))
		const result = await judgeJourneyGrade(makeInput(), apiCall)
		expect(apiCall).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(true)
	})
})

describe("judgePhaseGrade", () => {
	function ok(text: string): JudgeApiResult {
		return { ok: true, text }
	}

	function makePhaseInput(overrides: Partial<JudgePhaseInput> = {}): JudgePhaseInput {
		return {
			fermentName: "Test Ferment",
			phaseName: "Phase 1",
			phaseGoal: "Build retry plumbing.",
			phaseSummary: "Implemented retry logic with tests.",
			stepSummaries: "  - step-1: added retry.ts",
			gateVerdicts: [
				{ id: "F1", verdict: "pass", rationale: "step-1 used smoke" },
				{ id: "F2", verdict: "pass", rationale: "feature.ts:1-40 delivers retry" },
				{ id: "F3", verdict: "pass", rationale: "Nothing deferred" },
			],
			projectChecksSummary: "lint: clean\ntypecheck: clean",
			phaseDiff: { available: true, filesChanged: "feature.ts\nfeature.test.ts", diffSnippet: "+retry logic" },
			...overrides,
		}
	}

	it("returns parsed grade + rationale + recommendations on a clean B-grade response", async () => {
		const apiCall = vi.fn(async () =>
			ok(
				'{"grade":"B","rationale":"Goal met but coverage is thin.","recommendations":["Add edge-case test for empty input — untested path could NPE. Fix: add test. Evidence: test passes."]}',
			),
		)
		const result = await judgePhaseGrade(makePhaseInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("B")
		expect(result.rationale).toContain("coverage is thin")
		expect(result.recommendations).toHaveLength(1)
		expect(result.recommendations[0]).toContain("Add edge-case test")
	})

	it("returns [] recommendations on a clean A-grade response", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"clean","recommendations":[]}'))
		const result = await judgePhaseGrade(makePhaseInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.recommendations).toEqual([])
	})

	it("defaults recommendations to [] when the field is missing", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"clean"}'))
		const result = await judgePhaseGrade(makePhaseInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.recommendations).toEqual([])
	})

	it("defaults recommendations to [] when the field is null", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"clean","recommendations":null}'))
		const result = await judgePhaseGrade(makePhaseInput(), apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.recommendations).toEqual([])
	})

	it("returns invalid_grade when the model returns a non-letter", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"excellent","rationale":"x"}'))
		const result = await judgePhaseGrade(makePhaseInput(), apiCall)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.reason).toBe("invalid_grade")
		expect(result.detail).toContain("excellent")
	})

	it("returns unparseable when the model returns non-JSON garbage", async () => {
		const apiCall = vi.fn(async () => ok("I think this phase is pretty good honestly"))
		const result = await judgePhaseGrade(makePhaseInput(), apiCall)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.reason).toBe("unparseable")
	})

	it("propagates judge_unavailable when the API call fails", async () => {
		const apiCall = vi.fn(async (): Promise<JudgeApiResult> => ({ ok: false, reason: "no_auth" }))
		const result = await judgePhaseGrade(makePhaseInput(), apiCall)
		expect(apiCall).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.reason).toBe("no_auth")
	})

	it("retries empty_response before accepting a later grade", async () => {
		const apiCall = vi
			.fn<(_sys: string, _msg: string, _maxTokens?: number) => Promise<JudgeApiResult>>()
			.mockResolvedValueOnce({ ok: false, reason: "empty_response" })
			.mockResolvedValueOnce({ ok: false, reason: "empty_response" })
			.mockResolvedValueOnce(ok('{"grade":"B","rationale":"Recovered on retry.","recommendations":[]}'))

		const result = await judgePhaseGrade(makePhaseInput(), apiCall)

		expect(apiCall).toHaveBeenCalledTimes(3)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("B")
		expect(result.rationale).toContain("Recovered")
	})

	it("returns empty_response after the retry budget is exhausted", async () => {
		const apiCall = vi.fn(
			async (): Promise<JudgeApiResult> => ({
				ok: false,
				reason: "empty_response",
			}),
		)

		const result = await judgePhaseGrade(makePhaseInput(), apiCall)

		expect(apiCall).toHaveBeenCalledTimes(3)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.reason).toBe("empty_response")
		expect(result.detail).toContain("after 3 attempts")
	})

	it("includes phase goal, F-gate verdicts, project checks, and diff in the prompt", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"A","rationale":"x","recommendations":[]}')
		})
		await judgePhaseGrade(makePhaseInput(), apiCall)
		expect(captured).toContain("Phase goal: Build retry plumbing.")
		expect(captured).toContain("Phase summary: Implemented retry logic with tests.")
		expect(captured).toContain("step-1: added retry.ts")
		expect(captured).toContain("F1 (pass): step-1 used smoke")
		expect(captured).toContain("F2 (pass): feature.ts:1-40 delivers retry")
		expect(captured).toContain("lint: clean")
		expect(captured).toContain("Files changed:\nfeature.ts")
		expect(captured).toContain("+retry logic")
	})

	it("notes when no diff is available", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"C","rationale":"x","recommendations":[]}')
		})
		await judgePhaseGrade(makePhaseInput({ phaseDiff: { available: false } }), apiCall)
		expect(captured).toContain("No diff available")
	})

	it("includes agent-provided execution evidence in the prompt", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"A","rationale":"x","recommendations":[]}')
		})
		await judgePhaseGrade(
			makePhaseInput({
				evidence: "$ python3 verify.py\nAll 5 tests passed\n$ cat /app/result.txt\n42",
			}),
			apiCall,
		)
		expect(captured).toContain("EXECUTION EVIDENCE")
		expect(captured).toContain("All 5 tests passed")
		expect(captured).toContain("cat /app/result.txt")
	})

	it("includes execution evidence even when no diff is available", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"B","rationale":"x","recommendations":[]}')
		})
		await judgePhaseGrade(
			makePhaseInput({
				phaseDiff: { available: false },
				evidence: "$ stockfish analysis\nbest move: g2g4 (#+1)",
			}),
			apiCall,
		)
		expect(captured).toContain("No diff available")
		expect(captured).toContain("EXECUTION EVIDENCE")
		expect(captured).toContain("g2g4")
	})

	it("truncates evidence to 4 KB", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"A","rationale":"x","recommendations":[]}')
		})
		const longEvidence = "x".repeat(6000)
		await judgePhaseGrade(makePhaseInput({ evidence: longEvidence }), apiCall)
		expect(captured).toContain("EXECUTION EVIDENCE")
		const evidenceSection = captured.split("EXECUTION EVIDENCE")[1]
		expect(evidenceSection.length).toBeLessThan(5000)
	})

	it("omits the evidence section when evidence is empty", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"A","rationale":"x","recommendations":[]}')
		})
		await judgePhaseGrade(makePhaseInput({ evidence: "   " }), apiCall)
		expect(captured).not.toContain("EXECUTION EVIDENCE")
	})
})

describe("judgePhaseGradeViaSubagent", () => {
	function ok(text: string): JudgeApiResult {
		return { ok: true, text }
	}

	function makePhaseInput(overrides: Partial<JudgePhaseInput> = {}): JudgePhaseInput {
		return {
			fermentName: "Test Ferment",
			phaseName: "Phase 1",
			phaseGoal: "Build retry plumbing.",
			phaseSummary: "Implemented retry logic with tests.",
			stepSummaries: "  - step-1: added retry.ts",
			gateVerdicts: [
				{ id: "F1", verdict: "pass", rationale: "step-1 used smoke" },
				{ id: "F2", verdict: "pass", rationale: "feature.ts delivers retry" },
				{ id: "F3", verdict: "pass", rationale: "Nothing deferred" },
			],
			phaseDiff: { available: true, filesChanged: "feature.ts", diffSnippet: "+retry logic" },
			...overrides,
		}
	}

	it("returns the subagent's parsed grade when it completes with valid JSON", async () => {
		const spawn = vi.fn(
			async (): Promise<GraderSubagentResult> => ({
				text: '{"grade":"B","rationale":"Tests pass but coverage thin.","recommendations":["Add edge-case test"]}',
				status: "completed",
			}),
		)
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"x"}'))
		const result = await judgePhaseGradeViaSubagent(makePhaseInput(), spawn, apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("B")
		expect(result.rationale).toContain("coverage thin")
		expect(result.recommendations).toHaveLength(1)
		expect(apiCall).not.toHaveBeenCalled()
	})

	it("falls back to single-shot when subagent returns unparseable text", async () => {
		const spawn = vi.fn(
			async (): Promise<GraderSubagentResult> => ({
				text: "I think this work is pretty good",
				status: "completed",
			}),
		)
		const apiCall = vi.fn(async () => ok('{"grade":"C","rationale":"weak evidence"}'))
		const result = await judgePhaseGradeViaSubagent(makePhaseInput(), spawn, apiCall)
		expect(spawn).toHaveBeenCalledTimes(1)
		expect(apiCall).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("C")
	})

	it("falls back to single-shot when subagent aborts", async () => {
		const spawn = vi.fn(
			async (): Promise<GraderSubagentResult> => ({
				text: "",
				status: "aborted",
			}),
		)
		const apiCall = vi.fn(async () => ok('{"grade":"D","rationale":"gaps"}'))
		const result = await judgePhaseGradeViaSubagent(makePhaseInput(), spawn, apiCall)
		expect(apiCall).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("D")
	})

	it("falls back to single-shot when subagent throws", async () => {
		const spawn = vi.fn(async (): Promise<GraderSubagentResult> => {
			throw new Error("agent system not available")
		})
		const apiCall = vi.fn(async () => ok('{"grade":"B","rationale":"ok"}'))
		const result = await judgePhaseGradeViaSubagent(makePhaseInput(), spawn, apiCall)
		expect(apiCall).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("B")
	})

	it("falls back to single-shot when no spawner is provided", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"clean"}'))
		const result = await judgePhaseGradeViaSubagent(makePhaseInput(), undefined, apiCall)
		expect(apiCall).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("A")
	})
})

describe("judgeJourneyGradeViaSubagent", () => {
	function ok(text: string): JudgeApiResult {
		return { ok: true, text }
	}

	it("returns the subagent's parsed grade when it completes with valid JSON", async () => {
		const spawn = vi.fn(
			async (): Promise<GraderSubagentResult> => ({
				text: '{"grade":"A","rationale":"Excellent work.","recommendations":[]}',
				status: "completed",
			}),
		)
		const apiCall = vi.fn(async () => ok('{"grade":"C","rationale":"x"}'))
		const result = await judgeJourneyGradeViaSubagent(makeInput(), spawn, apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("A")
		expect(apiCall).not.toHaveBeenCalled()
	})

	it("surfaces the subagent's charter verdicts", async () => {
		const spawn = vi.fn(
			async (): Promise<GraderSubagentResult> => ({
				text: '{"grade":"B","rationale":"near miss","recommendations":[],"charter_verdicts":[{"clause":"recreate the Tahoe desktop","status":"unmet","evidence":"only a shell replica"}]}',
				status: "completed",
			}),
		)
		const apiCall = vi.fn(async () => ok('{"grade":"C","rationale":"x"}'))
		const result = await judgeJourneyGradeViaSubagent(makeInput(), spawn, apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.charterVerdicts).toEqual([
			{ clause: "recreate the Tahoe desktop", status: "unmet", evidence: "only a shell replica" },
		])
	})

	it("falls back to the single-shot judge when the subagent omits required charter verdicts", async () => {
		const spawn = vi.fn(
			async (): Promise<GraderSubagentResult> => ({
				text: '{"grade":"A","rationale":"fine","recommendations":[]}',
				status: "completed",
			}),
		)
		const apiCall = vi.fn(async () =>
			ok(
				'{"grade":"A","rationale":"ok","charter_verdicts":[{"clause":"recreate Tahoe","status":"met","evidence":"yes"}]}',
			),
		)
		const result = await judgeJourneyGradeViaSubagent(
			makeInput({ charter: { intent: "recreate Tahoe" } }),
			spawn,
			apiCall,
		)
		expect(spawn).toHaveBeenCalledTimes(1)
		expect(apiCall).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.charterVerdicts).toHaveLength(1)
	})

	it("keeps the subagent result when no charter exists (no audit required)", async () => {
		const spawn = vi.fn(
			async (): Promise<GraderSubagentResult> => ({
				text: '{"grade":"B","rationale":"fine","recommendations":[]}',
				status: "completed",
			}),
		)
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"x"}'))
		const result = await judgeJourneyGradeViaSubagent(makeInput(), spawn, apiCall)
		expect(apiCall).not.toHaveBeenCalled()
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("B")
	})

	it("falls back to single-shot when subagent returns unparseable text", async () => {
		const spawn = vi.fn(
			async (): Promise<GraderSubagentResult> => ({
				text: "Not JSON at all",
				status: "completed",
			}),
		)
		const apiCall = vi.fn(async () => ok('{"grade":"B","rationale":"ok"}'))
		const result = await judgeJourneyGradeViaSubagent(makeInput(), spawn, apiCall)
		expect(apiCall).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("B")
	})

	it("falls back to single-shot when subagent aborts", async () => {
		const spawn = vi.fn(
			async (): Promise<GraderSubagentResult> => ({
				text: "",
				status: "aborted",
			}),
		)
		const apiCall = vi.fn(async () => ok('{"grade":"C","rationale":"x"}'))
		const result = await judgeJourneyGradeViaSubagent(makeInput(), spawn, apiCall)
		expect(apiCall).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("C")
	})

	it("falls back to single-shot when no spawner is provided", async () => {
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"clean"}'))
		const result = await judgeJourneyGradeViaSubagent(makeInput(), undefined, apiCall)
		expect(apiCall).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("A")
	})

	it("extracts grade JSON from multi-turn text where JSON appears before the final message", async () => {
		// Simulates the case where the subagent produces the grade JSON at turn 8
		// but then continues with follow-up text on turns 9-11.
		const multiTurnText = [
			"Verifying phase...",
			"Ran tests: all passed.",
			'{"grade":"B","rationale":"Tests pass but coverage thin.","recommendations":["Add edge-case test"]}',
			"Already completed the grade for this phase. Final JSON was produced above.",
			"Already completed the grade for this phase. Final JSON was produced above.",
		].join("\n\n")
		const spawn = vi.fn(
			async (): Promise<GraderSubagentResult> => ({
				text: multiTurnText,
				status: "completed",
			}),
		)
		const apiCall = vi.fn(async () => ok('{"grade":"A","rationale":"x"}'))
		const result = await judgeJourneyGradeViaSubagent(makeInput(), spawn, apiCall)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.grade).toBe("B")
		expect(result.rationale).toContain("coverage thin")
		expect(apiCall).not.toHaveBeenCalled()
	})
})

describe("judge renders intent charter", () => {
	function ok(text: string): JudgeApiResult {
		return { ok: true, text }
	}

	it("phase prompt includes the charter when provided", async () => {
		let captured = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			captured = msg
			return ok('{"grade":"B","rationale":"x"}')
		})
		await judgePhaseGrade(
			{
				fermentName: "F",
				phaseName: "P1",
				phaseGoal: "g",
				charter: { intent: "Recreate the Tahoe desktop" },
				phaseSummary: "done",
				gateVerdicts: [],
			},
			apiCall,
		)
		expect(captured).toContain("INTENT CHARTER")
		expect(captured).toContain("Recreate the Tahoe desktop")
	})

	it("subagent grader prompt includes the charter when provided", async () => {
		let captured = ""
		const spawn = vi.fn(async (prompt: string): Promise<GraderSubagentResult> => {
			captured = prompt
			return { text: '{"grade":"A","rationale":"x"}', status: "completed" }
		})
		await judgePhaseGradeViaSubagent(
			{
				fermentName: "F",
				phaseName: "P1",
				phaseGoal: "g",
				charter: { intent: "Recreate the Tahoe desktop", demoScript: "Boot; look" },
				phaseSummary: "done",
				gateVerdicts: [],
			},
			spawn,
		)
		expect(captured).toContain("INTENT CHARTER")
		expect(captured).toContain("Boot; look")
		expect(spawn).toHaveBeenCalled()
	})
})

describe("describeJudgeModel", () => {
	const judgeModel = { provider: "kimchi-dev", id: "judge-x" } as unknown as Model<Api>
	const sessionModel = { provider: "kimchi-dev", id: "glm-5.2-fp8" } as unknown as Model<Api>
	const roleResolvingRegistry = { find: () => judgeModel } as unknown as ModelRegistry

	afterEach(() => {
		// Leave single-model mode behind so sibling describes keep their defaults.
		captureJudgeContext(undefined, undefined, false)
	})

	it("returns the captured session model in single-model mode, ignoring the role", () => {
		captureJudgeContext(sessionModel, roleResolvingRegistry, false)
		expect(describeJudgeModel()).toBe("kimchi-dev/glm-5.2-fp8")
	})

	it("returns the judge-role model in multi-model mode when the role resolves", () => {
		captureJudgeContext(sessionModel, roleResolvingRegistry, true)
		expect(describeJudgeModel()).toBe("kimchi-dev/judge-x")
	})

	it("falls back to the captured session model in multi-model mode when the role does not resolve", () => {
		captureJudgeContext(sessionModel, { find: () => undefined } as unknown as ModelRegistry, true)
		expect(describeJudgeModel()).toBe("kimchi-dev/glm-5.2-fp8")
	})
})
