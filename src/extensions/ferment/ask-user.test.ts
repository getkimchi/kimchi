import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import {
	type AskUserOption,
	askJudgeForm,
	askUserForm,
	normalizeAskUserQuestions,
	toScopingQuestionType,
} from "./ask-user.js"

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

	it("rejects form judge responses with invalid non-custom options", async () => {
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
		expect(result.failed).toBe(true)
		if (!result.failed) return
		expect(result.reason).toBe("judge_unparseable")
	})
})
