import { describe, expect, it } from "vitest"
import { formatAnswerText } from "./questionnaire.js"

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
