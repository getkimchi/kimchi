import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import {
	type AskUserOption,
	askJudge,
	askJudgeForm,
	askUser,
	askUserForm,
	normalizeAskUserQuestions,
	toScopingQuestionType,
} from "./ask-user.js"
import type { JudgeApiResult } from "./judge.js"

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

const opts: AskUserOption[] = [
	{ id: "proceed", label: "Proceed" },
	{ id: "pause", label: "Pause", description: "Stop and ask the user." },
	{ id: "abandon", label: "Abandon" },
]

describe("askUser routing", () => {
	it("routes to TUI when interactive and a UI is attached", async () => {
		const select = vi.fn(async () => "Pause")
		const result = await askUser("Continue?", opts, {
			ferment: makeFerment(),
			pi: makePi(),
			ctx: { ui: { select } as never },
		})
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.choice).toBe("pause")
		expect(result.answered_by).toBe("user")
		expect(select).toHaveBeenCalledWith("Continue?", ["Proceed", "Pause", "Abandon"])
	})

	it("returns user_cancelled when the TUI returns no selection", async () => {
		const select = vi.fn(async () => undefined)
		const result = await askUser("Continue?", opts, {
			ferment: makeFerment(),
			pi: makePi(),
			ctx: { ui: { select } as never },
		})
		expect(result.failed).toBe(true)
		if (!result.failed) return
		expect(result.reason).toBe("user_cancelled")
	})

	it("returns invalid_choice when the TUI returns a label not in the options", async () => {
		const select = vi.fn(async () => "Bogus")
		const result = await askUser("Continue?", opts, {
			ferment: makeFerment(),
			pi: makePi(),
			ctx: { ui: { select } as never },
		})
		expect(result.failed).toBe(true)
		if (!result.failed) return
		expect(result.reason).toBe("invalid_choice")
	})

	it("returns no_ui_no_judge when interactive but no TUI is attached", async () => {
		const result = await askUser("Continue?", opts, {
			ferment: makeFerment(),
			pi: makePi(),
			ctx: undefined,
		})
		expect(result.failed).toBe(true)
		if (!result.failed) return
		expect(result.reason).toBe("no_ui_no_judge")
	})

	it("returns invalid_choice when called with empty options", async () => {
		const result = await askUser("Continue?", [], {
			ferment: makeFerment(),
			pi: makePi(),
			ctx: undefined,
		})
		expect(result.failed).toBe(true)
		if (!result.failed) return
		expect(result.reason).toBe("invalid_choice")
	})

	it("routes to the judge when ferment-oneshot flag is set, ignoring any TUI", async () => {
		const select = vi.fn(async () => "Proceed")
		const fakeJudge = vi.fn(async () => ({
			choice: "pause",
			response_type: "single" as const,
			answered_by: "judge" as const,
			rationale: "Preserves optionality.",
		}))
		const result = await askUser(
			"Continue?",
			opts,
			{
				ferment: makeFerment(),
				pi: makePi({ "ferment-oneshot": true }),
				ctx: { ui: { select } as never },
			},
			{ askJudge: fakeJudge },
		)
		expect(select).not.toHaveBeenCalled()
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.choice).toBe("pause")
		expect(result.answered_by).toBe("judge")
		expect(result.rationale).toBe("Preserves optionality.")
	})

	it("routes confirm shorthand to the judge without requiring caller options", async () => {
		const ferment = makeFerment()
		const apiCall = vi.fn(async () => ({
			ok: true as const,
			text: '{"choice":"yes","rationale":"criteria are clear"}',
		}))
		const judge = vi.fn((question, options, activeFerment, responseType) =>
			askJudge(question, options, activeFerment, responseType, apiCall),
		)
		const result = await askUser(
			"Sound right?",
			[],
			{
				ferment,
				pi: makePi({ "ferment-oneshot": true }),
				ctx: undefined,
			},
			"confirm",
			{ askJudge: judge },
		)
		expect(judge).toHaveBeenCalledWith("Sound right?", [], ferment, "confirm")
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.response_type).toBe("confirm")
		expect(result.choice).toBe("yes")
		expect(result.answered_by).toBe("judge")
	})

	it("routes text questions to TUI input", async () => {
		const input = vi.fn(async () => "Use the conservative path.")
		const result = await askUser(
			"What else should I know?",
			[],
			{
				ferment: makeFerment(),
				pi: makePi(),
				ctx: { ui: { input } as never },
			},
			"text",
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.response_type).toBe("text")
		expect(result.text).toBe("Use the conservative path.")
		expect(result.answered_by).toBe("user")
	})

	it("routes multi questions through comma-separated input fallback when custom UI is unavailable", async () => {
		const input = vi.fn(async () => "1, Abandon")
		const result = await askUser(
			"Pick all acceptable actions.",
			opts,
			{
				ferment: makeFerment(),
				pi: makePi(),
				ctx: { ui: { input } as never },
			},
			"multi",
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.response_type).toBe("multi")
		expect(result.choices).toEqual(["proceed", "abandon"])
	})

	it("routes confirm shorthand as a Yes/No choice", async () => {
		const select = vi.fn(async () => "Yes")
		const result = await askUser(
			"Sound right?",
			[],
			{
				ferment: makeFerment(),
				pi: makePi(),
				ctx: { ui: { select } as never },
			},
			"confirm",
		)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.response_type).toBe("confirm")
		expect(result.choice).toBe("yes")
		expect(select).toHaveBeenCalledWith("Sound right?", ["Yes", "No"])
	})

	it("rejects confirm shorthand when caller supplies options", async () => {
		const result = await askUser(
			"Sound right?",
			[{ id: "custom-yes", label: "Sure" }],
			{
				ferment: makeFerment(),
				pi: makePi(),
				ctx: { ui: { select: vi.fn() } as never },
			},
			"confirm",
		)
		expect(result.failed).toBe(true)
		if (!result.failed) return
		expect(result.reason).toBe("invalid_choice")
		expect(result.detail).toContain("confirm")
	})

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
		expect(result.error).toContain("confirm")
	})

	it("rejects confirm questions that set allowOther instead of silently dropping it", () => {
		const result = normalizeAskUserQuestions([{ id: "ok", type: "confirm", prompt: "Proceed?", allowOther: true }])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain("allowOther")
	})

	it("preserves custom other-label for single/multi questions", () => {
		const result = normalizeAskUserQuestions([
			{
				id: "changes",
				type: "single",
				prompt: "Any additions?",
				options: [{ id: "no", label: "No" }],
				allowOther: true,
				otherLabel: "Yes (Type in your answer)",
			},
		])
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.questions[0]?.otherLabel).toBe("Yes (Type in your answer)")
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
		expect(result.error).toMatch(/Unknown question type/)
	})
})

describe("askJudge", () => {
	function ok(text: string): JudgeApiResult {
		return { ok: true, text }
	}

	it("returns the judge's parsed choice + rationale on a clean JSON response", async () => {
		const apiCall = vi.fn(async () => ok('{"choice":"pause","rationale":"safer"}'))
		const result = await askJudge("What now?", opts, makeFerment(), apiCall)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.choice).toBe("pause")
		expect(result.answered_by).toBe("judge")
		expect(result.rationale).toBe("safer")
	})

	it("strips markdown fences before parsing", async () => {
		const apiCall = vi.fn(async () => ok('```json\n{"choice":"abandon","rationale":"goal unmet"}\n```'))
		const result = await askJudge("What now?", opts, makeFerment(), apiCall)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.choice).toBe("abandon")
	})

	it("recovers when the model wraps its JSON in prose", async () => {
		const apiCall = vi.fn(async () =>
			ok('Based on the context, my answer is: {"choice":"proceed","rationale":"low risk"}. Hope this helps!'),
		)
		const result = await askJudge("What now?", opts, makeFerment(), apiCall)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.choice).toBe("proceed")
	})

	it("returns judge_unparseable when the choice id doesn't match any provided option", async () => {
		const apiCall = vi.fn(async () => ok('{"choice":"hallucinated","rationale":"made up"}'))
		const result = await askJudge("What now?", opts, makeFerment(), apiCall)
		expect(result.failed).toBe(true)
		if (!result.failed) return
		expect(result.reason).toBe("judge_unparseable")
	})

	it("returns judge_unavailable when the API call fails", async () => {
		const apiCall = vi.fn(async (): Promise<JudgeApiResult> => ({ ok: false, reason: "no_auth" }))
		const result = await askJudge("What now?", opts, makeFerment(), apiCall)
		expect(result.failed).toBe(true)
		if (!result.failed) return
		expect(result.reason).toBe("judge_unavailable")
		expect(result.detail).toContain("no_auth")
	})

	it("returns judge_unavailable on api_error including the detail message", async () => {
		const apiCall = vi.fn(
			async (): Promise<JudgeApiResult> => ({ ok: false, reason: "api_error", detail: "timeout after 45s" }),
		)
		const result = await askJudge("What now?", opts, makeFerment(), apiCall)
		expect(result.failed).toBe(true)
		if (!result.failed) return
		expect(result.detail).toContain("timeout after 45s")
	})

	it("parses multi-select judge responses", async () => {
		const apiCall = vi.fn(async () => ok('{"choices":["proceed","pause"],"rationale":"both are acceptable"}'))
		const result = await askJudge("What now?", opts, makeFerment(), "multi", apiCall)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.response_type).toBe("multi")
		expect(result.choices).toEqual(["proceed", "pause"])
	})

	it("parses text judge responses", async () => {
		const apiCall = vi.fn(async () => ok('{"text":"Ask for a reversible plan.","rationale":"safer"}'))
		const result = await askJudge("What should the user say?", [], makeFerment(), "text", apiCall)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.response_type).toBe("text")
		expect(result.text).toBe("Ask for a reversible plan.")
	})

	it("parses confirm judge responses with synthesized Yes/No options", async () => {
		let userMsg = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			userMsg = msg
			return ok('{"choice":"yes","rationale":"criteria are clear"}')
		})
		const result = await askJudge("Sound right?", [], makeFerment(), "confirm", apiCall)
		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(result.response_type).toBe("confirm")
		expect(result.choice).toBe("yes")
		expect(userMsg).toContain("Requested response type: confirm")
		expect(userMsg).toContain('id="yes"')
		expect(userMsg).toContain('id="no"')
	})

	it("shows allowOther labels to form judges and accepts custom single answers", async () => {
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
					otherLabel: "No (input what is wrong)",
				},
			],
			makeFerment(),
			apiCall,
		)

		expect(result.failed).toBeFalsy()
		if (result.failed) return
		expect(userMsg).toContain('option id="yes" label="Yes, looks good"')
		expect(userMsg).toContain('custom label="No (input what is wrong)" value="<free-form text>"')
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

	it("includes ferment goal and active phase in the judge prompt", async () => {
		let capturedUserMsg = ""
		const apiCall = vi.fn(async (_sys: string, msg: string) => {
			capturedUserMsg = msg
			return ok('{"choice":"proceed","rationale":"ok"}')
		})
		const f = makeFerment({
			goal: "Implement payment retry.",
			successCriteria: ["Failed payments retry 3x."],
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Build retry loop",
					goal: "Add retry plumbing.",
					status: "active",
					steps: [],
				} as never,
			],
		})
		await askJudge("Should I refactor first?", opts, f, apiCall)
		expect(capturedUserMsg).toContain("Implement payment retry.")
		expect(capturedUserMsg).toContain("Failed payments retry 3x.")
		expect(capturedUserMsg).toContain("Build retry loop")
		expect(capturedUserMsg).toContain("Should I refactor first?")
		expect(capturedUserMsg).toContain('id="proceed"')
	})
})
