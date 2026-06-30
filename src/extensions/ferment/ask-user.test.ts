import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { askJudgeForm, askUserForm, normalizeAskUserQuestions, toScopingQuestionType } from "./ask-user.js"

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "ferment-1",
		name: "Test Ferment",
		goal: "Ship the feature.",
		successCriteria: ["Tests pass; lint clean."],
		constraints: [],
		status: "running",
		worktree: { path: "/tmp/test", branch: undefined, commit: undefined },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}
}

function makePi(flags: Record<string, boolean> = {}): ExtensionAPI {
	return {
		getFlag: vi.fn((name: string) => flags[name]),
	} as unknown as ExtensionAPI
}

describe("askUserForm routing", () => {
	it("routes form questions through fallback UI when custom UI is unavailable", async () => {
		const select = vi.fn(async () => "Type your own answer")
		const input = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce("custom answer")
			.mockResolvedValueOnce("1, Type your own answer")
			.mockResolvedValueOnce("custom answer")
		const result = await askUserForm(
			"Clarify plan",
			"Pick the shape.",
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
					allowOther: true,
				},
				{
					id: "scope",
					type: "multi",
					prompt: "What is in scope?",
					options: [{ id: "tests", label: "Tests" }],
					allowOther: true,
				},
			],
			{
				ferment: makeFerment(),
				pi: makePi(),
				ctx: { ui: { select, input } as never },
			},
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.response_type).toBe("form")
		expect(result.answers).toEqual([
			{ id: "approach", type: "single", value: "custom answer", label: "custom answer", wasCustom: true },
			{
				id: "scope",
				type: "multi",
				value: "tests, custom answer",
				label: "Tests, custom answer",
				wasCustom: true,
				values: ["tests", "custom answer"],
				labels: ["Tests", "custom answer"],
			},
		])
	})
})

describe("toScopingQuestionType", () => {
	it("keeps the canonical question vocabulary unchanged", () => {
		expect(toScopingQuestionType("single")).toEqual({ type: "single", isConfirm: false })
		expect(toScopingQuestionType("multi")).toEqual({ type: "multi", isConfirm: false })
		expect(toScopingQuestionType("text")).toEqual({ type: "text", isConfirm: false })
		expect(toScopingQuestionType("confirm")).toEqual({ type: "confirm", isConfirm: true })
	})

	it("defaults to single only for omitted input", () => {
		expect(toScopingQuestionType(undefined)).toEqual({ type: "single", isConfirm: false })
	})

	it("throws on unknown strings instead of silently defaulting (no aliases)", () => {
		expect(() => toScopingQuestionType("radio")).toThrow(/Unknown question type/)
		expect(() => toScopingQuestionType("checkbox")).toThrow(/Unknown question type/)
		expect(() => toScopingQuestionType("bogus")).toThrow(/Unknown question type/)
	})
})

describe("normalizeAskUserQuestions", () => {
	it("keeps the canonical question vocabulary in ask_user forms (LLM-1928)", () => {
		const result = normalizeAskUserQuestions([
			{ id: "a", type: "single", prompt: "One?", options: [{ id: "x", label: "X" }] },
			{ id: "b", type: "multi", prompt: "Many?", options: [{ id: "y", label: "Y" }] },
			{ id: "c", type: "text", prompt: "Free?" },
		])
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.questions.map((q) => q.type)).toEqual(["single", "multi", "text"])
	})

	it("renders confirm as a fixed Yes/No question when no options are supplied", () => {
		const result = normalizeAskUserQuestions([{ id: "ok", type: "confirm", prompt: "Proceed?" }])
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.questions[0]?.type).toBe("confirm")
		expect(result.questions[0]?.options).toEqual([
			{ id: "yes", label: "Yes" },
			{ id: "no", label: "No" },
		])
	})

	it("rejects confirm questions that carry options instead of silently rewriting them", () => {
		const result = normalizeAskUserQuestions([
			{
				id: "ok",
				type: "confirm",
				prompt: "Proceed?",
				options: [
					{ id: "ship", label: "Ship it" },
					{ id: "hold", label: "Hold" },
				],
			},
		])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain('Question "ok" is type "confirm" and must not have options')
	})

	it("rejects confirm questions that set allowOther instead of silently dropping it", () => {
		const result = normalizeAskUserQuestions([{ id: "ok", type: "confirm", prompt: "Proceed?", allowOther: true }])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain('Question "ok" is type "confirm" and must not set allowOther')
	})

	it("reports an unknown type as a tool error rather than throwing", () => {
		expect(() =>
			normalizeAskUserQuestions([{ id: "bad", type: "bogus", prompt: "Which?", options: [{ id: "x", label: "X" }] }]),
		).not.toThrow()
		const result = normalizeAskUserQuestions([
			{ id: "bad", type: "bogus", prompt: "Which?", options: [{ id: "x", label: "X" }] },
		])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain('Question "bad" has unknown type "bogus"')
		expect(result.error).toContain("single, multi, text, confirm")
	})

	it("returns an actionable error naming the missing field when id is empty", () => {
		const result = normalizeAskUserQuestions([
			{ id: "", type: "single", prompt: "Which?", options: [{ id: "a", label: "A" }] },
		])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain('missing required field "id"')
	})

	it("returns an actionable error naming the question id when prompt is empty", () => {
		const result = normalizeAskUserQuestions([
			{ id: "q1", type: "single", prompt: "", options: [{ id: "a", label: "A" }] },
		])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain('Question "q1" is missing required field "prompt"')
	})

	it("returns an actionable error naming the id and valid types for an unknown type", () => {
		const result = normalizeAskUserQuestions([
			{ id: "bad", type: "bogus", prompt: "Which?", options: [{ id: "a", label: "A" }] },
		])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain('Question "bad" has unknown type "bogus"')
		expect(result.error).toContain("single, multi, text, confirm")
	})

	it("returns an actionable error when a confirm question carries options", () => {
		const result = normalizeAskUserQuestions([
			{ id: "ok", type: "confirm", prompt: "Proceed?", options: [{ id: "ship", label: "Ship" }] },
		])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain('Question "ok" is type "confirm" and must not have options')
	})

	it("returns an actionable error when a single question has no options", () => {
		const result = normalizeAskUserQuestions([{ id: "lonely", type: "single", prompt: "Pick one?" }])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain('Question "lonely" is type "single" but has no options')
	})

	it("returns an actionable error when a multi question has no options", () => {
		const result = normalizeAskUserQuestions([{ id: "lonely", type: "multi", prompt: "Pick many?" }])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain('Question "lonely" is type "multi" but has no options')
	})

	it("rejects duplicate question ids with an actionable message", () => {
		const result = normalizeAskUserQuestions([
			{ id: "dup", type: "single", prompt: "First?", options: [{ id: "a", label: "A" }] },
			{ id: "dup", type: "single", prompt: "Second?", options: [{ id: "b", label: "B" }] },
		])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain('Question id "dup" is duplicated')
	})
})

describe("askJudgeForm", () => {
	function ok(text: string) {
		return Promise.resolve({ ok: true as const, text })
	}

	it("shows the standard allowOther label and accepts custom single answers", async () => {
		let userMsg = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			userMsg = msg
			return ok(
				'{"answers":[{"id":"criteria_ok","value":"Add go test ./... as verification."}],"rationale":"needs verification"}',
			)
		})
		const result = await askJudgeForm(
			"Completion criteria",
			"I'll consider this done when README.md exists.",
			[
				{
					id: "criteria_ok",
					type: "single",
					prompt: "Do these completion criteria look right?",
					options: [{ id: "yes", label: "Yes, looks good" }],
					allowOther: true,
				},
			],
			makeFerment(),
			apiCall,
		)

		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(userMsg).toContain('option id="yes" label="Yes, looks good"')
		expect(userMsg).toContain('custom label="Type your own answer" value="<free-form text>"')
		expect(result.answers).toEqual([
			{
				id: "criteria_ok",
				type: "single",
				value: "Add go test ./... as verification.",
				label: "Add go test ./... as verification.",
				wasCustom: true,
			},
		])
	})

	it("parses structured form judge responses", async () => {
		const apiCall = vi.fn(async () =>
			ok(
				'{"answers":[{"id":"approach","value":"safe"},{"id":"scope","value":["tests","extra docs"]},{"id":"note","value":"Keep it reversible."}],"rationale":"safer"}',
			),
		)
		const result = await askJudgeForm(
			"Clarify plan",
			undefined,
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
				{
					id: "scope",
					type: "multi",
					prompt: "What is in scope?",
					options: [{ id: "tests", label: "Tests" }],
					allowOther: true,
				},
				{ id: "note", type: "text", prompt: "Anything else?" },
			],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.response_type).toBe("form")
		expect(result.answered_by).toBe("judge")
		expect(result.answers).toEqual([
			{ id: "approach", type: "single", value: "safe", label: "Safe path", wasCustom: false },
			{
				id: "scope",
				type: "multi",
				value: "tests, extra docs",
				label: "Tests, extra docs",
				wasCustom: true,
				values: ["tests", "extra docs"],
				labels: ["Tests", "extra docs"],
			},
			{ id: "note", type: "text", value: "Keep it reversible.", label: "Keep it reversible.", wasCustom: true },
		])
	})

	it("falls back to default when judge returns invalid non-custom options", async () => {
		const apiCall = vi.fn(async () => ok('{"answers":[{"id":"approach","value":"made_up"}],"rationale":"bad"}'))
		const result = await askJudgeForm(
			"Clarify plan",
			undefined,
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(apiCall).toHaveBeenCalledTimes(3)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answered_by).toBe("judge")
		expect(result.answers?.[0]?.value).toBe("safe")
	})

	it("retries on empty_response and succeeds on the third attempt", async () => {
		const apiCall = vi
			.fn<() => Promise<{ ok: true; text: string } | { ok: false; reason: "empty_response" }>>()
			.mockResolvedValueOnce({ ok: false, reason: "empty_response" })
			.mockResolvedValueOnce({ ok: false, reason: "empty_response" })
			.mockResolvedValueOnce({ ok: true, text: '{"answers":[{"id":"approach","value":"safe"}],"rationale":"ok"}' })
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(apiCall).toHaveBeenCalledTimes(3)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answers).toEqual([
			{ id: "approach", type: "single", value: "safe", label: "Safe path", wasCustom: false },
		])
	})

	it("retries on unparseable output and succeeds on the third attempt", async () => {
		const apiCall = vi
			.fn<() => Promise<{ ok: true; text: string }>>()
			.mockResolvedValueOnce({ ok: true, text: "garbage no json at all" })
			.mockResolvedValueOnce({ ok: true, text: "still not json" })
			.mockResolvedValueOnce({ ok: true, text: '{"answers":[{"id":"approach","value":"safe"}],"rationale":"ok"}' })
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(apiCall).toHaveBeenCalledTimes(3)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answers).toEqual([
			{ id: "approach", type: "single", value: "safe", label: "Safe path", wasCustom: false },
		])
	})

	it("falls back to defaults after exhausting retries on persistent empty_response", async () => {
		const apiCall = vi
			.fn<() => Promise<{ ok: false; reason: "empty_response" }>>()
			.mockResolvedValue({ ok: false, reason: "empty_response" })
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(apiCall).toHaveBeenCalledTimes(3)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answered_by).toBe("judge")
		expect(result.rationale).toContain("unavailable")
		expect(result.answers?.[0]?.value).toBe("safe")
	})

	it("falls back to defaults after exhausting retries on persistent unparseable output", async () => {
		const apiCall = vi.fn<() => Promise<{ ok: true; text: string }>>().mockResolvedValue({ ok: true, text: "garbage" })
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(apiCall).toHaveBeenCalledTimes(3)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answered_by).toBe("judge")
		expect(result.rationale).toContain("unavailable")
	})

	it("parses alternative judge format where answers are at the top level keyed by question id", async () => {
		const apiCall = vi.fn(async () => ok('{"approach":"safe","note":"Keep it simple.","rationale":"less risky"}'))
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
				{ id: "note", type: "text", prompt: "Any notes?" },
			],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answers).toEqual([
			{ id: "approach", type: "single", value: "safe", label: "Safe path", wasCustom: false },
			{ id: "note", type: "text", value: "Keep it simple.", label: "Keep it simple.", wasCustom: true },
		])
	})

	it("skips an invalid answer for an optional question without failing the whole form", async () => {
		const apiCall = vi.fn(async () =>
			ok('{"answers":[{"id":"approach","value":"safe"},{"id":"scope","value":"not_in_list"}],"rationale":"ok"}'),
		)
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
				{
					id: "scope",
					type: "single",
					prompt: "What scope?",
					options: [{ id: "tests", label: "Tests" }],
					required: false,
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answers).toEqual([
			{ id: "approach", type: "single", value: "safe", label: "Safe path", wasCustom: false },
		])
	})

	it("scales maxTokens with question count so multi-question forms are not truncated", async () => {
		const apiCall = vi.fn(async () =>
			ok(
				'{"answers":[{"id":"q1","value":"a"},{"id":"q2","value":"b"},{"id":"q3","value":"c"},{"id":"q4","value":"d"},{"id":"q5","value":"e"}],"rationale":"ok"}',
			),
		)
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{ id: "q1", type: "single", prompt: "1?", options: [{ id: "a", label: "A" }] },
				{ id: "q2", type: "single", prompt: "2?", options: [{ id: "b", label: "B" }] },
				{ id: "q3", type: "single", prompt: "3?", options: [{ id: "c", label: "C" }] },
				{ id: "q4", type: "single", prompt: "4?", options: [{ id: "d", label: "D" }] },
				{ id: "q5", type: "single", prompt: "5?", options: [{ id: "e", label: "E" }] },
			],
			makeFerment(),
			apiCall,
		)
		expect(apiCall).toHaveBeenCalledTimes(1)
		const calls = apiCall.mock.calls as unknown as Array<[string, string, number | undefined]>
		expect(calls.length).toBeGreaterThan(0)
		const maxTokens = calls[0]?.[2]
		expect(typeof maxTokens).toBe("number")
		expect(maxTokens).toBeGreaterThan(500)
		expect(maxTokens).toBeLessThanOrEqual(2000)
		expect(result.failed).toBeFalsy()
	})

	it("falls back to defaults when judge is unavailable due to no_auth", async () => {
		const apiCall = vi.fn(async () => ({ ok: false as const, reason: "no_auth" as const }))
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answered_by).toBe("judge")
		expect(result.rationale).toContain("unavailable")
	})

	it("parses confirm questions where the judge answers yes", async () => {
		const apiCall = vi.fn(async () => ok('{"answers":[{"id":"ok","value":"yes"}],"rationale":"proceed"}'))
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "ok",
					type: "confirm",
					prompt: "Proceed?",
					options: [
						{ id: "yes", label: "Yes" },
						{ id: "no", label: "No" },
					],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answers).toEqual([{ id: "ok", type: "confirm", value: "yes", label: "Yes", wasCustom: false }])
	})

	it("parses multi answers supplied as a comma-separated string", async () => {
		const apiCall = vi.fn(async () => ok('{"answers":[{"id":"scope","value":"a,b"}],"rationale":"ok"}'))
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "scope",
					type: "multi",
					prompt: "Pick?",
					options: [
						{ id: "a", label: "A" },
						{ id: "b", label: "B" },
					],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answers?.[0]?.values).toEqual(["a", "b"])
		expect(result.answers?.[0]?.labels).toEqual(["A", "B"])
	})

	it("parses multi answers supplied as a JSON array", async () => {
		const apiCall = vi.fn(async () => ok('{"answers":[{"id":"scope","value":["a","b"]}],"rationale":"ok"}'))
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "scope",
					type: "multi",
					prompt: "Pick?",
					options: [
						{ id: "a", label: "A" },
						{ id: "b", label: "B" },
					],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answers?.[0]?.values).toEqual(["a", "b"])
		expect(result.answers?.[0]?.labels).toEqual(["A", "B"])
	})

	it("parses judge output wrapped in a markdown code fence", async () => {
		const apiCall = vi.fn(async () =>
			ok('```json\n{"answers":[{"id":"approach","value":"safe"}],"rationale":"ok"}\n```'),
		)
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answers).toEqual([
			{ id: "approach", type: "single", value: "safe", label: "Safe path", wasCustom: false },
		])
	})

	it("parses judge output wrapped in prose via the regex fallback", async () => {
		const apiCall = vi.fn(async () =>
			ok('Here is my response:\n{"answers":[{"id":"approach","value":"safe"}],"rationale":"ok"}'),
		)
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answers).toEqual([
			{ id: "approach", type: "single", value: "safe", label: "Safe path", wasCustom: false },
		])
	})

	it("falls back to default answers when judge is always unavailable", async () => {
		const apiCall = vi.fn(async () => ({ ok: false as const, reason: "api_error" as const }))
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "q1",
					type: "single",
					prompt: "Pick?",
					options: [
						{ id: "a", label: "A" },
						{ id: "b", label: "B" },
					],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answered_by).toBe("judge")
		expect(result.rationale).toContain("unavailable")
		expect(result.answers?.[0]?.value).toBe("a")
	})

	it("falls back to default answers when judge output is always unparseable", async () => {
		const apiCall = vi.fn(async () => ({ ok: true as const, text: "garbage" }))
		const result = await askJudgeForm(
			undefined,
			undefined,
			[{ id: "q1", type: "single", prompt: "Pick?", options: [{ id: "a", label: "A" }] }],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answers?.[0]?.value).toBe("a")
	})

	it("fallback confirm defaults to 'yes'", async () => {
		const apiCall = vi.fn(async () => ({ ok: false as const, reason: "api_error" as const }))
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "ok",
					type: "confirm",
					prompt: "Proceed?",
					options: [
						{ id: "yes", label: "Yes" },
						{ id: "no", label: "No" },
					],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answers?.[0]?.value).toBe("yes")
		expect(result.answers?.[0]?.label).toBe("Yes")
	})

	it("fallback single defaults to first option", async () => {
		const apiCall = vi.fn(async () => ({ ok: false as const, reason: "empty_response" as const }))
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "q",
					type: "single",
					prompt: "Pick?",
					options: [
						{ id: "first", label: "First" },
						{ id: "second", label: "Second" },
					],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answers?.[0]?.value).toBe("first")
		expect(result.answers?.[0]?.label).toBe("First")
	})

	it("falls back to defaults when apiCall throws on every attempt (network errors)", async () => {
		const apiCall = vi.fn(async () => {
			throw new Error("network timeout")
		})
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "ok",
					type: "confirm",
					prompt: "Proceed?",
					options: [
						{ id: "yes", label: "Yes" },
						{ id: "no", label: "No" },
					],
				},
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [
						{ id: "safe", label: "Safe path" },
						{ id: "fast", label: "Fast path" },
					],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(apiCall).toHaveBeenCalledTimes(3)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answered_by).toBe("judge")
		expect(result.rationale?.toLowerCase()).toContain("default")
		expect(result.answers?.[0]?.value).toBe("yes")
		expect(result.answers?.[0]?.label).toBe("Yes")
		expect(result.answers?.[1]?.value).toBe("safe")
		expect(result.answers?.[1]?.label).toBe("Safe path")
	})

	it("treats a thrown apiCall as a failed attempt and recovers on the next attempt", async () => {
		const apiCall = vi
			.fn<() => Promise<{ ok: true; text: string }>>()
			.mockImplementationOnce(async () => {
				throw new Error("transient network error")
			})
			.mockResolvedValue({
				ok: true as const,
				text: '{"answers":[{"id":"approach","value":"safe"}],"rationale":"ok"}',
			})
		const result = await askJudgeForm(
			undefined,
			undefined,
			[
				{
					id: "approach",
					type: "single",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
			],
			makeFerment(),
			apiCall,
		)
		expect(apiCall).toHaveBeenCalledTimes(2)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.answered_by).toBe("judge")
		expect(result.answers).toEqual([
			{ id: "approach", type: "single", value: "safe", label: "Safe path", wasCustom: false },
		])
		expect(result.rationale).toBe("ok")
	})
})
