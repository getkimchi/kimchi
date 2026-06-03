import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import questionnaireExtension, { formatAnswerText, normalizeQuestionType } from "./questionnaire.js"

function registeredQuestionnaireTool() {
	let tool:
		| {
				execute: (
					toolCallId: string,
					params: unknown,
					signal: AbortSignal | undefined,
					onUpdate: unknown,
					ctx: unknown,
				) => Promise<{ content: { text: string }[]; details: { cancelled: boolean } }>
		  }
		| undefined
	const pi = {
		registerTool: vi.fn((registered) => {
			tool = registered as typeof tool
		}),
	} as unknown as ExtensionAPI
	questionnaireExtension(pi)
	if (!tool) throw new Error("questionnaire tool was not registered")
	return tool
}

describe("normalizeQuestionType", () => {
	it("keeps canonical question types unchanged", () => {
		expect(normalizeQuestionType(undefined)).toBe("single")
		expect(normalizeQuestionType("single")).toBe("single")
		expect(normalizeQuestionType("multi")).toBe("multi")
		expect(normalizeQuestionType("text")).toBe("text")
		expect(normalizeQuestionType("confirm")).toBe("confirm")
	})

	it("throws on unknown strings instead of defaulting to single (no aliases)", () => {
		expect(() => normalizeQuestionType("radio")).toThrow(/Unknown question type/)
		expect(() => normalizeQuestionType("checkbox")).toThrow(/Unknown question type/)
		expect(() => normalizeQuestionType("")).toThrow(/Unknown question type/)
	})
})

describe("questionnaire confirm validation", () => {
	it("rejects confirm options", async () => {
		const tool = registeredQuestionnaireTool()
		const result = await tool.execute(
			"call-1",
			{
				questions: [
					{
						id: "ship",
						type: "confirm",
						prompt: "Ship it?",
						options: [{ id: "sure", label: "Sure" }],
					},
				],
			},
			undefined,
			undefined,
			{ hasUI: true, ui: { custom: vi.fn() } },
		)
		expect(result.details.cancelled).toBe(true)
		expect(result.content[0]?.text).toContain('type "confirm"')
		expect(result.content[0]?.text).toContain("must not have options")
	})

	it("rejects allowOther on confirm", async () => {
		const tool = registeredQuestionnaireTool()
		const result = await tool.execute(
			"call-1",
			{
				questions: [{ id: "ship", type: "confirm", prompt: "Ship it?", allowOther: true }],
			},
			undefined,
			undefined,
			{ hasUI: true, ui: { custom: vi.fn() } },
		)
		expect(result.details.cancelled).toBe(true)
		expect(result.content[0]?.text).toContain('type "confirm"')
		expect(result.content[0]?.text).toContain("must not set allowOther")
	})
})

describe("formatAnswerText", () => {
	it("formats a single-select answer with index", () => {
		const questions = [
			{
				id: "scope",
				label: "Scope",
				prompt: "What scope?",
				type: "single" as const,
				options: [{ id: "auth", label: "Auth module" }],
				allowOther: false,
				required: true,
			},
		]
		const answers = [{ id: "scope", value: "auth", label: "Auth module", wasCustom: false, index: 1 }]
		expect(formatAnswerText(questions, answers)).toBe("Scope: user selected: 1. Auth module")
	})

	it("formats a custom (free-text) answer", () => {
		const questions = [
			{
				id: "scope",
				label: "Scope",
				prompt: "What scope?",
				type: "single" as const,
				options: [],
				allowOther: true,
				required: true,
			},
		]
		const answers = [{ id: "scope", value: "just the tests", label: "just the tests", wasCustom: true }]
		expect(formatAnswerText(questions, answers)).toBe("Scope: user wrote: just the tests")
	})

	it("formats a multi-select answer", () => {
		const questions = [
			{
				id: "features",
				label: "Features",
				prompt: "Which features?",
				type: "multi" as const,
				options: [
					{ id: "a", label: "Pagination" },
					{ id: "b", label: "Sorting" },
				],
				allowOther: false,
				required: true,
			},
		]
		const answers = [
			{
				id: "features",
				value: "Pagination, Sorting",
				label: "Pagination, Sorting",
				wasCustom: false,
				values: ["a", "b"],
				labels: ["Pagination", "Sorting"],
				indices: [1, 2],
			},
		]
		expect(formatAnswerText(questions, answers)).toBe("Features: user selected: 1. Pagination, 2. Sorting")
	})

	it("formats multiple answers across questions", () => {
		const questions = [
			{
				id: "scope",
				label: "Scope",
				prompt: "?",
				type: "single" as const,
				options: [{ id: "a", label: "A" }],
				allowOther: false,
				required: true,
			},
			{
				id: "priority",
				label: "Priority",
				prompt: "?",
				type: "single" as const,
				options: [{ id: "h", label: "High" }],
				allowOther: false,
				required: true,
			},
		]
		const answers = [
			{ id: "scope", value: "a", label: "A", wasCustom: false, index: 1 },
			{ id: "priority", value: "h", label: "High", wasCustom: false, index: 1 },
		]
		expect(formatAnswerText(questions, answers)).toBe("Scope: user selected: 1. A\nPriority: user selected: 1. High")
	})

	it("formats a confirm answer", () => {
		const questions = [
			{
				id: "proceed",
				label: "Confirm",
				prompt: "Proceed?",
				type: "confirm" as const,
				options: [
					{ id: "yes", label: "Yes" },
					{ id: "no", label: "No" },
				],
				allowOther: false,
				required: true,
			},
		]
		const answers = [{ id: "proceed", value: "yes", label: "Yes", wasCustom: false, index: 1 }]
		expect(formatAnswerText(questions, answers)).toBe("Confirm: user selected: 1. Yes")
	})

	it("handles an answer without index (e.g. confirm)", () => {
		const questions = [
			{
				id: "q1",
				label: "Q1",
				prompt: "?",
				type: "single" as const,
				options: [{ id: "v", label: "Val" }],
				allowOther: false,
				required: true,
			},
		]
		const answers = [{ id: "q1", value: "v", label: "Val", wasCustom: false }]
		expect(formatAnswerText(questions, answers)).toBe("Q1: user selected: Val")
	})

	it("uses answer id as fallback when question label not found", () => {
		const questions = [
			{
				id: "unknown",
				label: "X",
				prompt: "?",
				type: "single" as const,
				options: [],
				allowOther: true,
				required: true,
			},
		]
		const answers = [{ id: "missing_q", value: "v", label: "Val", wasCustom: false, index: 1 }]
		expect(formatAnswerText(questions, answers)).toBe("missing_q: user selected: 1. Val")
	})

	it("handles empty answers list", () => {
		const questions = [
			{ id: "q1", label: "Q1", prompt: "?", type: "single" as const, options: [], allowOther: true, required: true },
		]
		expect(formatAnswerText(questions, [])).toBe("")
	})

	it("formats multi-select with labels but no indices", () => {
		const questions = [
			{ id: "q1", label: "Q1", prompt: "?", type: "multi" as const, options: [], allowOther: false, required: true },
		]
		const answers = [
			{
				id: "q1",
				value: "a, b",
				label: "A, B",
				wasCustom: false,
				values: ["a", "b"],
				labels: ["A", "B"],
			},
		]
		expect(formatAnswerText(questions, answers)).toBe("Q1: user selected: A, B")
	})
})
