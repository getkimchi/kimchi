import { describe, expect, it, vi } from "vitest"
import { type JudgeApiResult, type JudgeJourneyGradeInput, isGrade, judgeJourneyGrade } from "./judge.js"

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
})
