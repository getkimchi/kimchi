import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { parseMultipleChoiceInput, promptQuestionnaireFallback } from "./questionnaire-fallback.js"
import { type Question, type QuestionOption, YES_NO_OPTIONS } from "./questionnaire-reducer.js"

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a fully-typed Question with sensible defaults so each test only states
 *  the fields that actually matter for the behavior under test. */
function makeQuestion(partial: Partial<Question> & Pick<Question, "id" | "prompt" | "type">): Question {
	return {
		label: partial.id,
		options: [],
		allowOther: false,
		required: true,
		...partial,
	}
}

interface UIHandlers {
	input?: ExtensionUIContext["input"]
	confirm?: ExtensionUIContext["confirm"]
	select?: ExtensionUIContext["select"]
}

function makeUI(handlers: UIHandlers): ExtensionUIContext {
	return {
		input: handlers.input,
		confirm: handlers.confirm,
		select: handlers.select,
	} as unknown as ExtensionUIContext
}

// ─── text type ────────────────────────────────────────────────────────────────

describe("promptQuestionnaireFallback — text type", () => {
	it("records the input verbatim as a custom answer", async () => {
		const ui = makeUI({ input: async () => "hello world" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({ id: "name", type: "text", prompt: "What is your name?" }),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toEqual([
			{
				id: "name",
				value: "hello world",
				label: "hello world",
				wasCustom: true,
			},
		])
	})

	it("asks the UI for input with the question prompt as title", async () => {
		const inputSpy = vi.fn(async () => "x")
		const ui = makeUI({ input: inputSpy })
		await promptQuestionnaireFallback(ui, [makeQuestion({ id: "name", type: "text", prompt: "What is your name?" })])
		expect(inputSpy).toHaveBeenCalledWith("What is your name?")
	})

	it("cancels when a required text question receives an empty input", async () => {
		const ui = makeUI({ input: async () => "" })
		const result = await promptQuestionnaireFallback(ui, [makeQuestion({ id: "name", type: "text", prompt: "Name?" })])
		expect(result.cancelled).toBe(true)
		expect(result.answers).toEqual([])
	})

	it("cancels when a required text question receives undefined (user dismissed)", async () => {
		const ui = makeUI({ input: async () => undefined })
		const result = await promptQuestionnaireFallback(ui, [makeQuestion({ id: "name", type: "text", prompt: "Name?" })])
		expect(result.cancelled).toBe(true)
	})

	it("skips (no answer, not cancelled) when an optional text question is left blank", async () => {
		const ui = makeUI({ input: async () => "" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "name",
				type: "text",
				prompt: "Name?",
				required: false,
			}),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toEqual([])
	})
})

// ─── confirm type ─────────────────────────────────────────────────────────────

describe("promptQuestionnaireFallback — confirm type", () => {
	it("returns the first (Yes) option when the user confirms", async () => {
		const ui = makeUI({ confirm: async () => true })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "proceed",
				type: "confirm",
				prompt: "Proceed?",
				options: [...YES_NO_OPTIONS],
			}),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toEqual([{ id: "proceed", value: "yes", label: "Yes", index: 1, wasCustom: false }])
	})

	it("returns the second (No) option with index 2 when the user declines", async () => {
		const ui = makeUI({ confirm: async () => false })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "proceed",
				type: "confirm",
				prompt: "Proceed?",
				options: [...YES_NO_OPTIONS],
			}),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toEqual([{ id: "proceed", value: "no", label: "No", index: 2, wasCustom: false }])
	})

	it("uses the question label as the confirm dialog title and prompt as message", async () => {
		const confirmSpy = vi.fn(async () => true)
		const ui = makeUI({ confirm: confirmSpy })
		await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "proceed",
				type: "confirm",
				label: "Continue?",
				prompt: "Should we ship this change?",
				options: [...YES_NO_OPTIONS],
			}),
		])
		expect(confirmSpy).toHaveBeenCalledWith("Continue?", "Should we ship this change?")
	})
})

// ─── multi type ───────────────────────────────────────────────────────────────

describe("promptQuestionnaireFallback — multi type", () => {
	const options = [
		{ id: "a", label: "Alpha" },
		{ id: "b", label: "Beta" },
		{ id: "c", label: "Gamma" },
	]

	it("parses dot-separated numeric selections into the matching options", async () => {
		const ui = makeUI({ input: async () => "1. Alpha, 3. Gamma" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
			}),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toHaveLength(1)
		expect(result.answers).toEqual([
			{
				id: "features",
				indices: [1, 3],
				label: "Alpha, Gamma",
				labels: ["Alpha", "Gamma"],
				value: "a, c",
				values: ["a", "c"],
				wasCustom: false,
			},
		])
	})

	it("parses parenthesised numeric forms like (1), (2)", async () => {
		const ui = makeUI({ input: async () => "(1), (3)" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
			}),
		])
		expect(result.answers).toEqual([
			{
				id: "features",
				indices: [1, 3],
				label: "Alpha, Gamma",
				labels: ["Alpha", "Gamma"],
				value: "a, c",
				values: ["a", "c"],
				wasCustom: false,
			},
		])
	})

	it("parses close-paren separators like 1) Alpha, 2) Beta", async () => {
		const ui = makeUI({ input: async () => "1) Alpha, 2) Beta" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
			}),
		])
		expect(result.answers).toEqual([
			{
				id: "features",
				indices: [1, 2],
				label: "Alpha, Beta",
				labels: ["Alpha", "Beta"],
				value: "a, b",
				values: ["a", "b"],
				wasCustom: false,
			},
		])
	})

	it("preserves the order of selections as the user typed them", async () => {
		const ui = makeUI({ input: async () => "3. Gamma, 1. Alpha" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
			}),
		])
		expect(result.answers).toEqual([
			{
				id: "features",
				indices: [3, 1],
				label: "Gamma, Alpha",
				labels: ["Gamma", "Alpha"],
				value: "c, a",
				values: ["c", "a"],
				wasCustom: false,
			},
		])
	})

	it("filters out indices that do not correspond to any option", async () => {
		const ui = makeUI({ input: async () => "1. Alpha, 99. Nope" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
			}),
		])
		expect(result.answers).toEqual([
			{
				id: "features",
				indices: [1],
				label: "Alpha",
				labels: ["Alpha"],
				value: "a",
				values: ["a"],
				wasCustom: false,
			},
		])
	})

	it("returns no answers when input parses to zero valid indices on a required question", async () => {
		// "abc" has no numeric form, so no indices parse and choices is empty → required → cancelled
		const ui = makeUI({ input: async () => "abc" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
			}),
		])
		expect(result.cancelled).toBe(true)
		expect(result.answers).toEqual([])
	})

	it("returns no answers when input parses only to out-of-range indices on a required question", async () => {
		// Indices parse to out-of-range positions → options[index] is undefined for every entry
		// → choices is empty → required → cancelled
		const opts = [{ id: "x", label: "X" }]
		const ui = makeUI({ input: async () => "99. NotInRange" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options: opts,
			}),
		])
		expect(result.cancelled).toBe(true)
		expect(result.answers).toEqual([])
	})

	it("continues (not cancelled, no answer) on a non-required question whose input fails to parse", async () => {
		const ui = makeUI({ input: async () => "abc" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
				required: false,
			}),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toEqual([])
	})

	it("cancels on empty input for a required multi question", async () => {
		const ui = makeUI({ input: async () => "" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
			}),
		])
		expect(result.cancelled).toBe(true)
	})

	it("skips on empty input for an optional multi question", async () => {
		const ui = makeUI({ input: async () => "" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
				required: false,
			}),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toEqual([])
	})

	it("renders the numbered option list as part of the input prompt", async () => {
		const inputSpy = vi.fn(async () => "1. Alpha")
		const ui = makeUI({ input: inputSpy })
		await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
			}),
		])
		expect(inputSpy).toHaveBeenCalledWith(
			"Pick features\n\n1. Alpha\n2. Beta\n3. Gamma",
			"Numbers or labels, comma-separated",
		)
	})

	it("appends custom user input when allowOther is true and marks the answer as custom", async () => {
		// 4 = __other__ index (after push)
		const ui = makeUI({ input: async () => "4. My custom answer" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
				allowOther: true,
			}),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toHaveLength(1)
		expect(result.answers).toEqual([
			{
				id: "features",
				label: "My custom answer",
				labels: ["My custom answer"],
				value: "My custom answer",
				values: ["My custom answer"],
				indices: [4],
				wasCustom: true,
			},
		])
	})

	it("uses the supplied otherLabel in the input prompt when allowOther is true", async () => {
		const inputSpy = vi.fn(async (_title: string, _placeholder?: string) => "4. Write something else")
		const ui = makeUI({ input: inputSpy })
		await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
				allowOther: true,
				otherLabel: "Write something else",
			}),
		])
		const promptArg = inputSpy.mock.calls[0][0]
		expect(promptArg).toContain("4. Write something else")
		expect(promptArg).not.toContain("Type your own answer")
	})

	it("does not mark a multi answer custom when selections include only normal options", async () => {
		const ui = makeUI({ input: async () => "1. Alpha, 2. Beta" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "features",
				type: "multi",
				prompt: "Pick features",
				options,
				allowOther: true,
			}),
		])
		expect(result.answers).toEqual([
			{
				id: "features",
				indices: [1, 2],
				label: "Alpha, Beta",
				labels: ["Alpha", "Beta"],
				value: "a, b",
				values: ["a", "b"],
				wasCustom: false,
			},
		])
	})
})

// ─── single type ──────────────────────────────────────────────────────────────

describe("promptQuestionnaireFallback — single type", () => {
	const options = [
		{ id: "a", label: "Alpha" },
		{ id: "b", label: "Beta" },
		{ id: "c", label: "Gamma" },
	]

	it("returns the selected option with index = position + 1", async () => {
		const ui = makeUI({ select: async () => "Beta" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "scope",
				type: "single",
				prompt: "Pick one",
				options,
			}),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toHaveLength(1)
		expect(result.answers).toEqual([{ id: "scope", value: "b", label: "Beta", index: 2, wasCustom: false }])
	})

	it("passes the option labels (no other) to ui.select", async () => {
		const selectSpy = vi.fn(async () => "Alpha")
		const ui = makeUI({ select: selectSpy })
		await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "scope",
				type: "single",
				prompt: "Pick one",
				options,
			}),
		])
		expect(selectSpy).toHaveBeenCalledWith("Pick one", ["Alpha", "Beta", "Gamma"])
	})

	it("cancels when select returns undefined for a required question", async () => {
		const ui = makeUI({ select: async () => undefined })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "scope",
				type: "single",
				prompt: "Pick one",
				options,
			}),
		])
		expect(result.cancelled).toBe(true)
		expect(result.answers).toEqual([])
	})

	it("skips when select returns undefined for a non-required question", async () => {
		const ui = makeUI({ select: async () => undefined })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "scope",
				type: "single",
				prompt: "Pick one",
				options,
				required: false,
			}),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toEqual([])
	})

	it("skips silently when select returns a label that does not match any option", async () => {
		const ui = makeUI({ select: async () => "NonExistent" })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "scope",
				type: "single",
				prompt: "Pick one",
				options,
			}),
		])
		// The label does not match — fallback does not call input (no __other__ path) and does
		// not push an answer. Behaviour is "skip", not "cancel", regardless of required: a
		// missing option id is treated as an unknown selector result.
		expect(result.cancelled).toBe(false)
		expect(result.answers).toEqual([])
	})

	it("does not append the 'other' option when allowOther is false", async () => {
		const selectSpy = vi.fn(async () => "Alpha")
		const ui = makeUI({ select: selectSpy })
		await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "scope",
				type: "single",
				prompt: "Pick one",
				options,
				allowOther: false,
			}),
		])
		expect(selectSpy).toHaveBeenCalledWith("Pick one", ["Alpha", "Beta", "Gamma"])
	})

	it("appends the default 'Type your own answer' label when allowOther is true", async () => {
		const selectSpy = vi.fn(async () => "Alpha")
		const ui = makeUI({ select: selectSpy })
		await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "scope",
				type: "single",
				prompt: "Pick one",
				options,
				allowOther: true,
			}),
		])
		expect(selectSpy).toHaveBeenCalledWith("Pick one", ["Alpha", "Beta", "Gamma", "Type your own answer"])
	})

	it("uses the supplied otherLabel in the select list when allowOther is true", async () => {
		const selectSpy = vi.fn(async () => "Alpha")
		const ui = makeUI({ select: selectSpy })
		await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "scope",
				type: "single",
				prompt: "Pick one",
				options,
				allowOther: true,
				otherLabel: "Write something else",
			}),
		])
		expect(selectSpy).toHaveBeenCalledWith("Pick one", ["Alpha", "Beta", "Gamma", "Write something else"])
	})

	it("prompts for custom text when __other__ is selected and stores it as a custom answer", async () => {
		const ui = makeUI({
			select: async () => "Type your own answer",
			input: async () => "my free text",
		})
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "scope",
				type: "single",
				prompt: "Pick one",
				options,
				allowOther: true,
			}),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toHaveLength(1)
		expect(result.answers).toEqual([
			{
				id: "scope",
				value: "my free text",
				label: "my free text",
				wasCustom: true,
				index: 4,
			},
		])
	})

	it("prompts for custom text using '<prompt>\\n\\nYour answer:' as the input title", async () => {
		const inputSpy = vi.fn(async () => "x")
		const ui = makeUI({
			select: async () => "Type your own answer",
			input: inputSpy,
		})
		await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "scope",
				type: "single",
				prompt: "Pick one",
				options,
				allowOther: true,
			}),
		])
		expect(inputSpy).toHaveBeenCalledWith("Pick one\n\nYour answer:")
	})

	it("cancels when __other__ is selected but the custom input is empty on a required question", async () => {
		const ui = makeUI({
			select: async () => "Type your own answer",
			input: async () => "",
		})
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "scope",
				type: "single",
				prompt: "Pick one",
				options,
				allowOther: true,
			}),
		])
		expect(result.cancelled).toBe(true)
		expect(result.answers).toEqual([])
	})

	it("skips when __other__ is selected but the custom input is empty on a non-required question", async () => {
		const ui = makeUI({
			select: async () => "Type your own answer",
			input: async () => "",
		})
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "scope",
				type: "single",
				prompt: "Pick one",
				options,
				allowOther: true,
				required: false,
			}),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toEqual([])
	})
})

// ─── multi-question flow ──────────────────────────────────────────────────────

describe("promptQuestionnaireFallback — multi-question flow", () => {
	it("preserves the original questions array on the result", async () => {
		const ui = makeUI({ input: async () => "x" })
		const questions = [makeQuestion({ id: "a", type: "text", prompt: "?" })]
		const result = await promptQuestionnaireFallback(ui, questions)
		expect(result.questions).toBe(questions)
	})

	it("processes questions in order and accumulates answers", async () => {
		const inputSpy = vi.fn(async () => "typed")
		const confirmSpy = vi.fn(async () => true)
		const ui = makeUI({ input: inputSpy, confirm: confirmSpy })
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "a",
				type: "text",
				prompt: "First?",
				required: false,
			}),
			makeQuestion({
				id: "b",
				type: "confirm",
				prompt: "Second?",
				options: [...YES_NO_OPTIONS],
			}),
		])
		expect(inputSpy).toHaveBeenCalledWith("First?")
		// Confirm uses label (defaults to id "b") as title, prompt as message
		expect(confirmSpy).toHaveBeenCalledWith("b", "Second?")
		expect(result.cancelled).toBe(false)
		expect(result.answers).toHaveLength(2)
		expect(result.answers).toEqual([
			{
				id: "a",
				label: "typed",
				value: "typed",
				wasCustom: true,
			},
			{
				id: "b",
				index: 1,
				label: "Yes",
				value: "yes",
				wasCustom: false,
			},
		])
	})

	it("returns partial answers if a later required question cancels the flow", async () => {
		const ui = makeUI({
			input: async (title: string) => {
				if (title === "First?") return "good"
				return "" // second question is required and empty → cancel
			},
		})
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({ id: "a", type: "text", prompt: "First?" }),
			makeQuestion({ id: "b", type: "text", prompt: "Second?" }),
		])
		expect(result.cancelled).toBe(true)
		expect(result.answers).toHaveLength(1)
		expect(result.answers).toEqual([
			{
				id: "a",
				label: "good",
				value: "good",
				wasCustom: true,
			},
		])
	})

	it("returns an empty answers array and cancelled=false for zero questions", async () => {
		const ui = makeUI({})
		const result = await promptQuestionnaireFallback(ui, [])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toEqual([])
		expect(result.questions).toEqual([])
	})

	it("mixes question types in a single run", async () => {
		let inputCalls = 0
		const ui = makeUI({
			input: async (title: string) => {
				inputCalls++
				// 1st input call: multi selection. 2nd: text answer.
				if (title.startsWith("Pick:")) return "1. Alpha"
				return "text response"
			},
			confirm: async () => true,
			select: async () => "Beta",
		})
		const result = await promptQuestionnaireFallback(ui, [
			makeQuestion({
				id: "q1",
				type: "multi",
				prompt: "Pick:",
				options: [
					{ id: "a", label: "Alpha" },
					{ id: "b", label: "Beta" },
				],
			}),
			makeQuestion({
				id: "q2",
				type: "text",
				prompt: "Anything else?",
				required: false,
			}),
			makeQuestion({
				id: "q3",
				type: "confirm",
				prompt: "Done?",
				options: [...YES_NO_OPTIONS],
			}),
		])
		expect(result.cancelled).toBe(false)
		expect(result.answers).toHaveLength(3)
		expect(result.answers).toEqual([
			{
				id: "q1",
				indices: [1],
				label: "Alpha",
				labels: ["Alpha"],
				value: "a",
				values: ["a"],
				wasCustom: false,
			},
			{
				id: "q2",
				label: "text response",
				value: "text response",
				wasCustom: true,
			},
			{
				id: "q3",
				index: 1,
				label: "Yes",
				value: "yes",
				wasCustom: false,
			},
		])
		expect(inputCalls).toBe(2) // one input call for multi, one for text — confirm and select bypass input
	})
})

describe("parseMultipleChoiceInput", () => {
	const baseOptions: QuestionOption[] = [
		{ id: "r", label: "Rabbit" },
		{ id: "c", label: "Carrot" },
		{ id: "l", label: "Lettuce" },
	]

	const optionsWithOther: QuestionOption[] = [
		{ id: "r", label: "Rabbit" },
		{ id: "c", label: "Carrot" },
		{ id: "__other__", label: "Other" },
	]

	describe("numbered input", () => {
		it("parses a single number", () => {
			expect(parseMultipleChoiceInput("1", baseOptions)).toEqual([{ type: "selected", index: 1 }])
		})

		it("parses a single number with dot", () => {
			expect(parseMultipleChoiceInput("1.", baseOptions)).toEqual([{ type: "selected", index: 1 }])
		})

		it("parses a single number with dash", () => {
			expect(parseMultipleChoiceInput("1-", baseOptions)).toEqual([{ type: "selected", index: 1 }])
		})

		it("parses a single number with parentheses", () => {
			expect(parseMultipleChoiceInput("(1)", baseOptions)).toEqual([{ type: "selected", index: 1 }])
		})

		it("parses a single number with closing paren", () => {
			expect(parseMultipleChoiceInput("1)", baseOptions)).toEqual([{ type: "selected", index: 1 }])
		})

		it("parses multiple comma-separated numbers", () => {
			expect(parseMultipleChoiceInput("1, 3", baseOptions)).toEqual([
				{ type: "selected", index: 1 },
				{ type: "selected", index: 3 },
			])
		})

		it("parses multiple newline-separated numbers", () => {
			expect(parseMultipleChoiceInput("1.\n2.\n3.", baseOptions)).toEqual([
				{ type: "selected", index: 1 },
				{ type: "selected", index: 2 },
				{ type: "selected", index: 3 },
			])
		})

		it("ignores out-of-range numbers", () => {
			expect(parseMultipleChoiceInput("1, 5", baseOptions)).toEqual([{ type: "selected", index: 1 }])
		})

		it("ignores zero and negative numbers", () => {
			expect(parseMultipleChoiceInput("0, -1, 2", baseOptions)).toEqual([{ type: "selected", index: 2 }])
		})

		it("returns empty array for no valid numbers", () => {
			expect(parseMultipleChoiceInput("yes please", baseOptions)).toEqual([])
		})
	})

	describe("label input", () => {
		it("matches a single label", () => {
			expect(parseMultipleChoiceInput("Rabbit", baseOptions)).toEqual([{ type: "selected", index: 1 }])
		})

		it("matches multiple comma-separated labels", () => {
			expect(parseMultipleChoiceInput("Rabbit, Carrot", baseOptions)).toEqual([
				{ type: "selected", index: 1 },
				{ type: "selected", index: 2 },
			])
		})

		it("matches multiple newline-separated labels", () => {
			expect(parseMultipleChoiceInput("Rabbit\nCarrot", baseOptions)).toEqual([
				{ type: "selected", index: 1 },
				{ type: "selected", index: 2 },
			])
		})

		it("is case-insensitive", () => {
			expect(parseMultipleChoiceInput("RABBIT, carrot", baseOptions)).toEqual([
				{ type: "selected", index: 1 },
				{ type: "selected", index: 2 },
			])
		})

		it("returns correct indexes for answers out of order", () => {
			// Lettuce=3, Rabbit=1
			expect(parseMultipleChoiceInput("Lettuce\nRabbit", baseOptions)).toEqual([
				{ type: "selected", index: 1 },
				{ type: "selected", index: 3 },
			])
		})

		it("does not partial match labels", () => {
			expect(parseMultipleChoiceInput("Rabb", baseOptions)).toEqual([])
		})

		it("returns empty array for unrecognized labels without __other__", () => {
			expect(parseMultipleChoiceInput("Broccoli", baseOptions)).toEqual([])
		})
	})

	describe("__other__ option — numbered input", () => {
		it("captures trailing text after other option number", () => {
			expect(parseMultipleChoiceInput("3: Broccoli", optionsWithOther)).toEqual([
				{ type: "custom", index: 3, value: "Broccoli" },
			])
		})

		it("captures other value alongside selected options", () => {
			expect(parseMultipleChoiceInput("1, 3: Broccoli", optionsWithOther)).toEqual([
				{ type: "selected", index: 1 },
				{ type: "custom", index: 3, value: "Broccoli" },
			])
		})

		it("ignores other option number with no trailing value", () => {
			expect(parseMultipleChoiceInput("1, 3", optionsWithOther)).toEqual([{ type: "selected", index: 1 }])
		})
	})

	describe("__other__ option — label input", () => {
		it("captures unrecognized label as custom value", () => {
			expect(parseMultipleChoiceInput("Broccoli", optionsWithOther)).toEqual([
				{ type: "custom", index: 3, value: "Broccoli" },
			])
		})

		it("captures custom value alongside matched labels", () => {
			expect(parseMultipleChoiceInput("Rabbit, Broccoli", optionsWithOther)).toEqual([
				{ type: "selected", index: 1 },
				{ type: "custom", index: 3, value: "Broccoli" },
			])
		})

		it("captures multiple unrecognized parts as separate custom values", () => {
			expect(parseMultipleChoiceInput("Broccoli, Spinach", optionsWithOther)).toEqual([
				{ type: "custom", index: 3, value: "Broccoli" },
				{ type: "custom", index: 3, value: "Spinach" },
			])
		})
	})

	describe("edge cases", () => {
		it("handles empty string", () => {
			expect(parseMultipleChoiceInput("", baseOptions)).toEqual([])
		})

		it("handles whitespace-only input", () => {
			expect(parseMultipleChoiceInput("   ", baseOptions)).toEqual([])
		})

		it("handles empty options list", () => {
			expect(parseMultipleChoiceInput("1, 2", [])).toEqual([])
		})

		it("handles extra whitespace around inputs", () => {
			expect(parseMultipleChoiceInput("  Rabbit  ,  Carrot  ", baseOptions)).toEqual([
				{ type: "selected", index: 1 },
				{ type: "selected", index: 2 },
			])
		})
	})
})
