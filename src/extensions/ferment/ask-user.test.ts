import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { type AskUserOption, askJudge, askUser } from "./ask-user.js"
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
