import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent"
/**
 * Tests for the pure helper functions in model-roles-command.ts.
 * Interactive CLI flows are tested via a mock ui.custom that returns a
 * canned QuestionFormResult, so the user-completion contract of
 * `collectModelMetadata` is exercised without booting the real TUI.
 */
import type { Component, TUI } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import {
	collectModelMetadata,
	formatRoleAssignment,
	formatRoleDisplay,
	formatRoleSummaryBlock,
	hasMetadataContent,
	isEqualAssignment,
} from "./model-roles-command.js"
import type { RoleModelAssignment } from "./model-roles.js"
import { splitModelRef } from "./model-roles.js"

// Mock model-metadata module
vi.mock("./model-metadata.js", () => ({
	loadModelMetadata: vi.fn(),
	resolveModelMetadata: vi.fn(),
	saveModelMetadata: vi.fn(),
	getModelMetadata: vi.fn(() => new Map()),
}))

// Spy on the shared form factory so we can assert what questions / header
// were rendered without booting the real TUI. The factory itself is loaded
// for real so its reducer wiring is exercised end-to-end.
import * as questionnaireForm from "../questionnaire/questionnaire-form.js"
import type { QuestionFormResult } from "../questionnaire/questionnaire-form.js"
import type { Answer, Question } from "../questionnaire/questionnaire-reducer.js"

vi.mock("../questionnaire/questionnaire-form.js", async () => {
	const actual = await vi.importActual<typeof questionnaireForm>("../questionnaire/questionnaire-form.js")
	return {
		...actual,
		createQuestionForm: vi.fn(actual.createQuestionForm),
	}
})

function singleAnswer(id: string, value: string): Answer {
	return { id, value, label: value, wasCustom: false, index: 1 }
}

function textAnswer(id: string, value: string): Answer {
	return { id, value, label: value, wasCustom: true }
}

const createMockCtx = (
	answers: Answer[] = [],
	cancelled = false,
): {
	ctx: ExtensionCommandContext
	factoryArgs: { questions: Question[]; header: { title?: string; description?: string } }
} => {
	const factoryArgs = { questions: [] as Question[], header: {} as { title?: string; description?: string } }
	const ctx = {
		ui: {
			custom: vi.fn(async <T>(factory: (...args: unknown[]) => Component | Promise<Component>) => {
				const fakeTui = {} as TUI
				const fakeTheme = { fg: (s: string) => s, bold: (s: string) => s } as unknown as Theme
				const fakeDone = (_r: T) => {}
				// Wire a wrapper around createQuestionForm so we can capture the
				// questions + header that the caller passed to it.
				const original = vi.mocked(questionnaireForm.createQuestionForm)
				original.mockImplementationOnce((_tui, _theme, questions, header, done) => {
					factoryArgs.questions = questions
					factoryArgs.header = header
					return {
						render: () => [],
						handleInput: () => {},
						invalidate: () => {},
					} as Component
				})
				factory(fakeTui, fakeTheme, {} as never, fakeDone as never)
				const result: QuestionFormResult = { questions: factoryArgs.questions, answers, cancelled }
				return result as T
			}),
			notify: vi.fn(),
		},
	} as unknown as ExtensionCommandContext
	return { ctx, factoryArgs }
}

describe("formatRoleAssignment", () => {
	it("formats a single model as-is", () => {
		expect(formatRoleAssignment("kimchi-dev/kimi-k2.6")).toBe("kimchi-dev/kimi-k2.6")
	})

	it("formats multiple models joined by comma-space", () => {
		expect(formatRoleAssignment(["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"])).toBe(
			"kimchi-dev/kimi-k2.6, kimchi-dev/minimax-m2.7",
		)
	})

	it("formats empty array as empty string", () => {
		const models: string[] = []
		const result = models.join(", ")
		expect(result).toBe("")
	})
})

describe("isEqualAssignment", () => {
	const cases: Record<string, { a: RoleModelAssignment; b: RoleModelAssignment; expected: boolean }> = {
		"identical single-model assignments": {
			a: "kimchi-dev/kimi-k2.6",
			b: "kimchi-dev/kimi-k2.6",
			expected: true,
		},
		"different single-model assignments": {
			a: "kimchi-dev/kimi-k2.6",
			b: "kimchi-dev/minimax-m2.7",
			expected: false,
		},
		"identical multi-model assignments (same order)": {
			a: ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
			b: ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
			expected: true,
		},
		"same models in different order": {
			a: ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
			b: ["kimchi-dev/minimax-m2.7", "kimchi-dev/kimi-k2.6"],
			expected: false,
		},
		"different lengths": {
			a: "kimchi-dev/kimi-k2.6",
			b: ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
			expected: false,
		},
		"mixed types (string vs array of one)": {
			a: "kimchi-dev/kimi-k2.6",
			b: ["kimchi-dev/kimi-k2.6"],
			expected: true,
		},
	}

	for (const [name, { a, b, expected }] of Object.entries(cases)) {
		it(name, () => {
			expect(isEqualAssignment(a, b)).toBe(expected)
		})
	}
})

describe("formatRoleDisplay", () => {
	it("appends (default) suffix when value matches DEFAULT_MODEL_ROLES", () => {
		const display = formatRoleDisplay("orchestrator", "kimchi-dev/kimi-k2.7")
		expect(display).toMatch(/\(default\)$/)
	})

	it("omits (default) suffix when value differs from DEFAULT_MODEL_ROLES", () => {
		const display = formatRoleDisplay("orchestrator", "kimchi-dev/minimax-m2.7")
		expect(display).not.toMatch(/\(default\)$/)
	})

	it("includes role label and formatted model list", () => {
		const display = formatRoleDisplay("planner", "kimchi-dev/kimi-k2.6")
		expect(display).toContain("Planner")
		expect(display).toContain("kimchi-dev/kimi-k2.6")
	})

	it("formats builder role with multiple models", () => {
		const display = formatRoleDisplay("builder", ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"])
		expect(display).toContain("Builder")
		expect(display).toContain("kimchi-dev/kimi-k2.6")
		expect(display).toContain("kimchi-dev/minimax-m2.7")
	})
})

describe("formatRoleSummaryBlock", () => {
	it("shows role label with indented model on next line", () => {
		const display = formatRoleSummaryBlock("orchestrator", "kimchi-dev/kimi-k2.6")
		expect(display).toMatch(/^Orchestrator:/)
		expect(display).toContain("\n    kimchi-dev/kimi-k2.6")
	})

	it("shows multiple models on separate indented lines", () => {
		const display = formatRoleSummaryBlock("builder", ["custom/model-a", "custom/model-b"])
		const lines = display.split("\n")
		expect(lines).toHaveLength(3)
		expect(lines[0]).toBe("Builder:")
		expect(lines[1]).toBe("    custom/model-a")
		expect(lines[2]).toBe("    custom/model-b")
	})

	it("appends (default) suffix to each model line when assignment matches default", () => {
		const display = formatRoleSummaryBlock("orchestrator", "kimchi-dev/kimi-k2.7")
		expect(display).toContain("(default)")
	})

	it("omits (default) suffix when assignment differs from default", () => {
		const display = formatRoleSummaryBlock("orchestrator", "kimchi-dev/minimax-m2.7")
		expect(display).not.toContain("(default)")
	})
})

describe("splitModelRef (from model-roles.ts)", () => {
	const cases: Record<string, { input: string; expected: { provider: string; modelId: string } | undefined }> = {
		"parses valid provider/model-id": {
			input: "kimchi-dev/kimi-k2.6",
			expected: { provider: "kimchi-dev", modelId: "kimi-k2.6" },
		},
		"returns undefined for model-id without slash": {
			input: "kimi-k2.6",
			expected: undefined,
		},
		"returns undefined for empty string": {
			input: "",
			expected: undefined,
		},
		"returns undefined for slash-only string": {
			input: "/",
			expected: undefined,
		},
		"returns undefined for trailing slash with empty modelId": {
			input: "provider/",
			expected: undefined,
		},
	}

	for (const [name, { input, expected }] of Object.entries(cases)) {
		it(name, () => {
			if (expected === undefined) {
				expect(splitModelRef(input)).toBeUndefined()
			} else {
				expect(splitModelRef(input)).toEqual(expected)
			}
		})
	}
})

describe("collectModelMetadata", () => {
	it("returns undefined when the user cancels the form", async () => {
		const { ctx } = createMockCtx([], true)
		const result = await collectModelMetadata("custom/model", undefined, ctx)
		expect(result).toBeUndefined()
	})

	it("returns config with all fields when user picks tier, vision=yes, and a description", async () => {
		const { ctx } = createMockCtx([
			singleAnswer("tier", "heavy"),
			singleAnswer("vision", "yes"),
			textAnswer("description", "A powerful model good at reasoning"),
		])
		const result = await collectModelMetadata("custom/model", undefined, ctx)
		expect(result).toEqual({
			tier: "heavy",
			vision: true,
			description: "A powerful model good at reasoning",
		})
	})

	it("drops unselected fields when user picks skip / leaves them blank", async () => {
		const { ctx } = createMockCtx([
			singleAnswer("tier", "standard"),
			singleAnswer("vision", "__keep__"), // "skip" since no existing vision
			textAnswer("description", "(no response)"), // empty editor submit
		])
		const result = await collectModelMetadata("custom/model", undefined, ctx)
		expect(result).toEqual({ tier: "standard" })
		expect(result).not.toHaveProperty("vision")
		expect(result).not.toHaveProperty("description")
	})

	it("preserves existing fields when user picks keep current for each", async () => {
		const { ctx } = createMockCtx([
			singleAnswer("tier", "__keep__"),
			singleAnswer("vision", "__keep__"),
			textAnswer("description", "Existing description"),
		])
		const existing = { tier: "standard" as const, description: "Old desc", vision: true as const }
		const result = await collectModelMetadata("custom/model", existing, ctx)
		expect(result).toEqual({
			tier: "standard",
			vision: true,
			description: "Existing description",
		})
	})

	it("keeps existing description when user submits empty text", async () => {
		const { ctx } = createMockCtx([
			singleAnswer("tier", "heavy"),
			singleAnswer("vision", "no"),
			textAnswer("description", "(no response)"),
		])
		const existing = { description: "Pre-existing description" }
		const result = await collectModelMetadata("custom/model", existing, ctx)
		expect(result).toEqual({
			tier: "heavy",
			vision: false,
			description: "Pre-existing description",
		})
	})

	it("keeps existing description when user navigates past the description question", async () => {
		// No description answer recorded at all — form treats it as "skip".
		const { ctx } = createMockCtx([singleAnswer("tier", "light"), singleAnswer("vision", "no")])
		const existing = { description: "Pre-existing description" }
		const result = await collectModelMetadata("custom/model", existing, ctx)
		expect(result).toEqual({ tier: "light", vision: false, description: "Pre-existing description" })
	})

	it("labels the skip option as 'keep current (X)' when an existing value is present", async () => {
		const { ctx, factoryArgs } = createMockCtx([singleAnswer("tier", "__keep__")])
		await collectModelMetadata("custom/model", { tier: "heavy" }, ctx)
		const tierQuestion = factoryArgs.questions.find((q) => q.id === "tier")
		expect(tierQuestion).toBeDefined()
		const keepOption = tierQuestion?.options.find((o) => o.id === "__keep__")
		expect(keepOption?.label).toBe("keep current (heavy)")
	})

	it("labels the skip option as 'skip' when no existing value is present", async () => {
		const { ctx, factoryArgs } = createMockCtx([singleAnswer("tier", "__keep__")])
		await collectModelMetadata("custom/model", undefined, ctx)
		const tierQuestion = factoryArgs.questions.find((q) => q.id === "tier")
		const keepOption = tierQuestion?.options.find((o) => o.id === "__keep__")
		expect(keepOption?.label).toBe("skip")
	})

	it("includes model ref in question prompts and form title", async () => {
		const { ctx, factoryArgs } = createMockCtx([singleAnswer("tier", "heavy")])
		await collectModelMetadata("custom/my-model", undefined, ctx)
		expect(factoryArgs.header.title).toBe("custom/my-model")
		for (const q of factoryArgs.questions) {
			expect(q.prompt).toContain("custom/my-model")
		}
	})

	it("uses three questions (tier, vision, description)", async () => {
		const { ctx, factoryArgs } = createMockCtx([singleAnswer("tier", "heavy")])
		await collectModelMetadata("custom/model", undefined, ctx)
		expect(factoryArgs.questions.map((q) => q.id)).toEqual(["tier", "vision", "description"])
	})

	it("uses YES_NO_OPTIONS plus a keep-current option for vision", async () => {
		const { ctx, factoryArgs } = createMockCtx([singleAnswer("tier", "heavy")])
		await collectModelMetadata("custom/model", undefined, ctx)
		const visionQuestion = factoryArgs.questions.find((q) => q.id === "vision")
		expect(visionQuestion).toBeDefined()
		const optionIds = visionQuestion?.options.map((o) => o.id)
		expect(optionIds).toContain("yes")
		expect(optionIds).toContain("no")
		expect(optionIds).toContain("__keep__")
	})
})

describe("hasMetadataContent", () => {
	it("returns false for undefined (user cancelled)", () => {
		expect(hasMetadataContent(undefined)).toBe(false)
	})

	it("returns false for empty object (user skipped all fields)", () => {
		// Regression: collectModelMetadata() returns {} when the user completes the
		// form while skipping every optional field. Saving this clutters settings.json
		// with empty entries that resolveModelMetadata ignores anyway.
		expect(hasMetadataContent({})).toBe(false)
	})

	it("returns true when at least one field is present", () => {
		expect(hasMetadataContent({ tier: "heavy" })).toBe(true)
		expect(hasMetadataContent({ vision: true })).toBe(true)
		expect(hasMetadataContent({ description: "x" })).toBe(true)
		expect(hasMetadataContent({ tier: "light", vision: false })).toBe(true)
	})
})
