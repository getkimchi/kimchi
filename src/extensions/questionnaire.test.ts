import { afterEach, describe, expect, it } from "vitest"
import {
	clearFermentStartApproval,
	consumeFermentStartApproval,
	formatAnswerText,
	normalizeQuestionType,
	normalizeQuestionsForPurpose,
	recordFermentStartApproval,
} from "./questionnaire.js"

describe("normalizeQuestionType", () => {
	it("accepts UI-style aliases emitted by models", () => {
		expect(normalizeQuestionType("radio")).toBe("single")
		expect(normalizeQuestionType("checkbox")).toBe("multi")
	})

	it("keeps canonical question types unchanged", () => {
		expect(normalizeQuestionType(undefined)).toBe("single")
		expect(normalizeQuestionType("single")).toBe("single")
		expect(normalizeQuestionType("multi")).toBe("multi")
		expect(normalizeQuestionType("text")).toBe("text")
		expect(normalizeQuestionType("confirm")).toBe("confirm")
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
				options: [{ value: "auth", label: "Auth module" }],
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
					{ value: "a", label: "Pagination" },
					{ value: "b", label: "Sorting" },
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
				options: [{ value: "a", label: "A" }],
				allowOther: false,
				required: true,
			},
			{
				id: "priority",
				label: "Priority",
				prompt: "?",
				type: "single" as const,
				options: [{ value: "h", label: "High" }],
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
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
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
				options: [{ value: "v", label: "Val" }],
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

describe("ferment start approval tracking", () => {
	const startQuestion = {
		id: "start",
		label: "Start",
		prompt: "This looks like multi-phase work — start a ferment for it?",
		type: "confirm" as const,
		options: [
			{ value: "yes", label: "Yes, start the ferment" },
			{ value: "no", label: "No, handle it inline" },
		],
		allowOther: false,
		required: true,
	}

	afterEach(() => {
		clearFermentStartApproval()
	})

	it("forces ferment-start approval choices to canonical yes/no", () => {
		const [question] = normalizeQuestionsForPurpose(
			[
				{
					...startQuestion,
					type: "single" as const,
					options: [
						{ value: "Yes, start a ferment", label: "Yes, start a ferment" },
						{ value: "No, handle inline", label: "No, handle inline" },
					],
					allowOther: true,
					required: false,
				},
			],
			"ferment_start_approval",
		)

		expect(question).toMatchObject({
			type: "confirm",
			options: [
				{ value: "yes", label: "Yes" },
				{ value: "no", label: "No" },
			],
			allowOther: false,
			required: true,
		})
	})

	it("records and consumes a yes answer to the start-ferment confirm question", () => {
		recordFermentStartApproval(
			"ferment_start_approval",
			[startQuestion],
			[{ id: "start", value: "yes", label: "Yes, start the ferment", wasCustom: false, index: 1 }],
			100,
		)

		expect(consumeFermentStartApproval(101)).toBe(true)
		expect(consumeFermentStartApproval(102)).toBe(false)
	})

	it("records the first confirm option even when the model omits canonical yes/no values", () => {
		recordFermentStartApproval(
			"ferment_start_approval",
			[startQuestion],
			[{ id: "start", value: "Yes, start a ferment", label: "Yes, start a ferment", wasCustom: false, index: 1 }],
			100,
		)

		expect(consumeFermentStartApproval(101)).toBe(true)
	})

	it("does not record without the explicit ferment-start purpose", () => {
		recordFermentStartApproval(
			undefined,
			[startQuestion],
			[{ id: "start", value: "yes", label: "Yes, start the ferment", wasCustom: false, index: 1 }],
			100,
		)

		expect(consumeFermentStartApproval(101)).toBe(false)
	})

	it("does not record no answers", () => {
		recordFermentStartApproval(
			"ferment_start_approval",
			[startQuestion],
			[{ id: "start", value: "no", label: "No, handle it inline", wasCustom: false, index: 2 }],
			100,
		)

		expect(consumeFermentStartApproval(101)).toBe(false)
	})
})
