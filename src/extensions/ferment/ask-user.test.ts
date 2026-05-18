import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { type AskUserOption, askJudge, askJudgeForm, askUser, askUserForm } from "./ask-user.js"
import type { JudgeApiResult } from "./judge.js"

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "ferment-1",
		name: "Test Ferment",
		goal: "Ship the feature.",
		successCriteria: "Tests pass; lint clean.",
		constraints: [],
		status: "running",
		mode: "auto",
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
					type: "radio",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
					allowOther: true,
				},
				{
					id: "scope",
					type: "checkbox",
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
			{ id: "approach", type: "radio", value: "custom answer", label: "custom answer", wasCustom: true },
			{
				id: "scope",
				type: "checkbox",
				value: "tests, custom answer",
				label: "Tests, custom answer",
				wasCustom: true,
				values: ["tests", "custom answer"],
				labels: ["Tests", "custom answer"],
			},
		])
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
					type: "radio",
					prompt: "Which approach?",
					options: [{ id: "safe", label: "Safe path" }],
				},
				{
					id: "scope",
					type: "checkbox",
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
			{ id: "approach", type: "radio", value: "safe", label: "Safe path", wasCustom: false },
			{
				id: "scope",
				type: "checkbox",
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
					type: "radio",
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
			successCriteria: "Failed payments retry 3x.",
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
