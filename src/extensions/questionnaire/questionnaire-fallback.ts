import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import type { Answer, Question, QuestionOption } from "./questionnaire-reducer.js"

export interface QuestionnaireResult {
	questions: Question[]
	answers: Answer[]
	cancelled: boolean
}

type ParsedChoice =
	| {
			type: "selected"
			/** 1-based user selection index */
			index: number
	  }
	| {
			type: "custom"
			/** 1-based user selection index */
			index: number
			value: string
	  }

const NUMBERED_OPTION_RE = /(?:\((\d+)\)|(?<![-])(\d+)[ \t]*[-.):]?)[ \t]*([^\n,]+)?/g

function parseNumber(match: RegExpMatchArray): number {
	return Number.parseInt(match[1] ?? match[2], 10)
}

function isValidIndex(index: number, options: QuestionOption[]): boolean {
	return Number.isFinite(index) && index >= 1 && index <= options.length
}

function splitParts(input: string): string[] {
	return input
		.split(/,|\n/)
		.map((s) => s.trim())
		.filter(Boolean)
}

function matchesLabel(part: string, option: QuestionOption): boolean {
	return part.toLowerCase() === option.label.toLowerCase()
}

function parseNumberedInput(trimmed: string, options: QuestionOption[], otherIndex: number): ParsedChoice[] | null {
	const matches = [...trimmed.matchAll(NUMBERED_OPTION_RE)]
	if (matches.length === 0) return null

	return matches.flatMap((match): ParsedChoice[] => {
		const index = parseNumber(match)
		if (!isValidIndex(index, options)) return []

		if (index - 1 === otherIndex) {
			const value = match[3]?.trim()
			return value ? [{ type: "custom", index, value }] : []
		}

		return [{ type: "selected", index }]
	})
}

function parseLabelInput(trimmed: string, options: QuestionOption[], otherIndex: number): ParsedChoice[] {
	const parts = splitParts(trimmed)

	const selected = options.flatMap((option, i): ParsedChoice[] => {
		if (option.id === "__other__") return []
		return parts.some((part) => matchesLabel(part, option)) ? [{ type: "selected", index: i + 1 }] : []
	})

	if (otherIndex === -1) return selected

	const customValues = parts
		.filter((part) => !options.some((o) => o.id !== "__other__" && matchesLabel(part, o)))
		.map(
			(value): ParsedChoice => ({
				type: "custom",
				index: otherIndex + 1,
				value,
			}),
		)

	return [...selected, ...customValues]
}

/** Returns 1-based selection. `options` must be a list of option labels of the same order and length as the available options. */
export function parseMultipleChoiceInput(input: string, options: QuestionOption[]): ParsedChoice[] {
	if (options.length === 0) return []

	const trimmed = input.trim()
	if (!trimmed) return []

	const otherIndex = options.findIndex((o) => o.id === "__other__")

	return parseNumberedInput(trimmed, options, otherIndex) ?? parseLabelInput(trimmed, options, otherIndex)
}

export async function promptQuestionnaireFallback(
	ui: ExtensionUIContext,
	questions: Question[],
): Promise<QuestionnaireResult> {
	const answers: Answer[] = []

	for (const question of questions) {
		const questionText = question.prompt

		switch (question.type) {
			case "text": {
				const value = await ui.input(questionText)
				if (!value && question.required) return { questions, answers, cancelled: true }
				if (value)
					answers.push({
						id: question.id,
						value,
						label: value,
						wasCustom: true,
					})
				continue
			}
			case "confirm": {
				const confirmed = await ui.confirm(question.label, questionText)
				const option = confirmed ? question.options[0] : question.options[1]
				answers.push({
					id: question.id,
					value: option.id,
					label: option.label,
					index: confirmed ? 1 : 2,
					wasCustom: false,
				})
				continue
			}
			case "single": {
				const options = [...question.options]
				if (question.allowOther) {
					options.push({
						id: "__other__",
						label: question.otherLabel ?? "Type your own answer",
					})
				}
				const selected = await ui.select(
					questionText,
					options.map((o) => o.label),
				)
				if (!selected) {
					if (question.required) return { questions, answers, cancelled: true }
					continue
				}
				const index = options.findIndex((o) => o.label === selected)
				const option = options[index]
				if (!option) continue
				if (option.id === "__other__") {
					const custom = await ui.input(`${questionText}\n\nYour answer:`)
					if (!custom && question.required) return { questions, answers, cancelled: true }
					if (custom)
						answers.push({
							id: question.id,
							value: custom,
							label: selected,
							index: index + 1,
							wasCustom: true,
						})
				} else {
					answers.push({
						id: question.id,
						value: option.id,
						label: option.label,
						index: index + 1,
						wasCustom: false,
					})
				}
				continue
			}

			case "multi": {
				let customOption: QuestionOption
				const options = [...question.options]
				if (question.allowOther) {
					customOption = {
						id: "__other__",
						label: question.otherLabel ?? "Type your own answer",
					}
					options.push(customOption)
				}
				const raw = await ui.input(
					`${questionText}\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}`,
					"Numbers or labels, comma-separated",
				)
				if (!raw && question.required) return { questions, answers, cancelled: true }
				if (!raw) continue
				const selectedOptions = parseMultipleChoiceInput(raw, options)
				const choices = selectedOptions
					.filter((choice) => choice.type === "selected" || question.allowOther)
					.map((choice) => {
						if (choice.type === "custom") {
							return {
								...customOption,
								value: choice.value,
								index: choice.index,
							}
						}
						// User selection is 1-based
						const option = options[choice.index - 1]
						return {
							...option,
							value: option.id,
							index: choice.index,
						}
					})
				if (!choices.length) {
					if (question.required) return { questions, answers, cancelled: true }
					continue
				}
				answers.push({
					id: question.id,
					value: choices.map((item) => item.value).join(", "),
					values: choices.map((item) => item.value),
					label: choices.map((item) => item.label).join(", "),
					labels: choices.map((item) => item.label),
					indices: choices.map((item) => item.index),
					wasCustom: choices.some((item) => item.id === "__other__"),
				})
				continue
			}
			default:
				break
		}
	}

	return { questions, answers, cancelled: false }
}
