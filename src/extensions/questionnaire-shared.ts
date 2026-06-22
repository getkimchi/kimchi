import {
	type Answer,
	type Question,
	type QuestionOption,
	type QuestionType,
	YES_NO_OPTIONS,
} from "./questionnaire-reducer.js"

export interface RawQuestion {
	id: string
	label?: string
	prompt: string
	type?: string
	options?: QuestionOption[]
	allowOther?: boolean
	otherLabel?: string
	required?: boolean
}

/** Normalize an agent-supplied question type to the canonical vocabulary. */
export function normalizeQuestionType(type: string | undefined): QuestionType {
	if (type === undefined) return "single"
	const canonical: Record<string, QuestionType> = {
		single: "single",
		multi: "multi",
		text: "text",
		confirm: "confirm",
	}
	const mapped = canonical[type.toLowerCase()]
	if (!mapped) throw new Error(`Unknown question type: "${type}". Expected single, multi, text, or confirm.`)
	return mapped
}

export function normalizeQuestion(q: RawQuestion, index: number): Question {
	const type = normalizeQuestionType(q.type)
	const rawOptions = q.options ?? []
	const normalizedOptions = rawOptions.map((opt) => ({
		id: opt.id,
		label: opt.label,
		description: opt.description,
	}))
	return {
		id: q.id,
		label: q.label || `Q${index + 1}`,
		prompt: q.prompt,
		type,
		options: type === "confirm" ? [...YES_NO_OPTIONS] : normalizedOptions,
		allowOther: q.allowOther ?? type === "single",
		otherLabel: q.otherLabel,
		required: q.required !== false,
	}
}

export function validateRawQuestions(questions: RawQuestion[]): string | undefined {
	for (const q of questions) {
		const type = normalizeQuestionType(q.type)
		if (type !== "confirm") continue
		if ((q.options?.length ?? 0) > 0) {
			return `Question "${q.id}" is type "confirm" and must not have options — confirm is always Yes/No.`
		}
		if (q.allowOther) {
			return `Question "${q.id}" is type "confirm" and must not set allowOther — confirm is always Yes/No.`
		}
	}
	return undefined
}

export function validateQuestions(questions: Question[]): string | undefined {
	for (const q of questions) {
		if ((q.type === "single" || q.type === "multi") && q.options.length === 0 && !q.allowOther) {
			return `Question "${q.id}" is type "${q.type}" but has no options and allowOther is false.`
		}
	}
	return undefined
}

/** Format answers as human-readable text for the LLM. */
export function formatAnswerText(questions: Question[], answers: Answer[]): string {
	return answers
		.map((a) => {
			const qLabel = questions.find((q) => q.id === a.id)?.label || a.id
			if (a.values && a.labels) {
				const items = a.labels
					.map((l, i) => {
						const idx = a.indices?.[i]
						return idx ? `${idx}. ${l}` : l
					})
					.join(", ")
				return `${qLabel}: user selected: ${items}`
			}
			if (a.wasCustom) {
				return `${qLabel}: user wrote: ${a.label}`
			}
			const display = a.index ? `${a.index}. ${a.label}` : a.label
			return `${qLabel}: user selected: ${display}`
		})
		.join("\n")
}
