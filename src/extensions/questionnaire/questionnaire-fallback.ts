import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import type { Answer, Question } from "./questionnaire-reducer.js"

export interface QuestionnaireResult {
	questions: Question[]
	answers: Answer[]
	cancelled: boolean
}

function parseMultipleChoiceInput(input: string): number[] {
	const trimmed = input.trim()

	const matches = [...trimmed.matchAll(/(?:\((\d+)\)|(\d+)\s*[-.)])\s*/g)]

	return matches.map((match) => Number.parseInt(match[1] ?? match[2], 10) - 1).filter((index) => Number.isFinite(index))
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
				if (value) answers.push({ id: question.id, value, label: value, wasCustom: true })
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
			case "multi": {
				const options = [...question.options]
				if (question.allowOther) {
					options.push({ id: "__other__", label: question.otherLabel ?? "Type your own answer" })
				}
				const raw = await ui.input(
					`${questionText}\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}`,
					"Numbers or labels, comma-separated",
				)
				if (!raw && question.required) return { questions, answers, cancelled: true }
				if (!raw) continue
				const indices = parseMultipleChoiceInput(raw)
				const choices = indices.map((index) => options[index]).filter((choice) => !!choice)
				if (!choices.length) {
					if (question.required) return { questions, answers, cancelled: true }
					continue
				}
				answers.push({
					id: question.id,
					value: choices.map((item) => item.id).join(", "),
					values: choices.map((item) => item.id),
					label: choices.map((item) => item.label).join(", "),
					labels: choices.map((item) => item.label),
					indices: indices,
					wasCustom: choices.some((item) => item.id === "__other__"),
				})
				continue
			}
			case "single": {
				const options = [...question.options]
				if (question.allowOther) {
					options.push({ id: "__other__", label: question.otherLabel ?? "Type your own answer" })
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
					if (custom) answers.push({ id: question.id, value: custom, label: custom, wasCustom: true })
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
			default:
				break
		}
	}

	return { questions, answers, cancelled: false }
}
