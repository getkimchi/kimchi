import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent"
import type { Component, TUI } from "@earendil-works/pi-tui"
import type { ScopingQuestionType } from "../../ferment/types.js"
import { createQuestionForm } from "../questionnaire-form.js"
import type { Answer, Question, QuestionType } from "../questionnaire-reducer.js"
import { setTipWidgetLocation } from "../tips/index.js"

export type PromptUi = {
	select?: (title: string, options: string[]) => Promise<string | undefined>
	input?: (title: string, placeholder?: string) => Promise<string | undefined>
	editor?: (title: string, prefill?: string) => Promise<string | undefined>
	custom?: ExtensionUIContext["custom"]
	setWorkingVisible?: (visible: boolean) => void
}

export interface PromptEditorOptions {
	placeholder?: string
	prefill?: string
}

export interface PromptChoiceOption {
	label: string
	description?: string
}

export type PromptFormQuestionType = ScopingQuestionType

export interface PromptFormOption {
	id: string
	label: string
	description?: string
}

export interface PromptFormQuestion {
	id: string
	type: PromptFormQuestionType
	prompt: string
	label?: string
	options?: ReadonlyArray<PromptFormOption>
	allowOther?: boolean
	otherLabel?: string
	required?: boolean
	default?: string | string[]
	placeholder?: string
}

export interface PromptFormSpec {
	title?: string
	description?: string
	questions: ReadonlyArray<PromptFormQuestion>
}

export type PromptFormAnswer = Answer

export interface PromptFormResult {
	questions: Question[]
	answers: PromptFormAnswer[]
	cancelled: boolean
}

export function getPromptUi(ctx: unknown): PromptUi | undefined {
	return (ctx as { ui?: PromptUi } | undefined)?.ui
}

export async function withWorkingHidden<T>(ui: PromptUi, fn: () => Promise<T>): Promise<T> {
	const restoreTips = setTipWidgetLocation("hidden")
	try {
		ui.setWorkingVisible?.(false)
		return await fn()
	} finally {
		try {
			ui.setWorkingVisible?.(true)
		} finally {
			restoreTips()
		}
	}
}

export function promptSelect(ctx: unknown, title: string, options: string[]): Promise<string | undefined> {
	const ui = getPromptUi(ctx)
	if (!ui?.select) return Promise.resolve(undefined)
	return withWorkingHidden(ui, () => ui.select?.(title, options) ?? Promise.resolve(undefined))
}

export function promptInput(ctx: unknown, title: string, placeholder?: string): Promise<string | undefined> {
	const ui = getPromptUi(ctx)
	if (!ui?.input) return Promise.resolve(undefined)
	return withWorkingHidden(ui, () => ui.input?.(title, placeholder) ?? Promise.resolve(undefined))
}

export function promptEditor(
	ctx: unknown,
	title: string,
	options: PromptEditorOptions = {},
): Promise<string | undefined> {
	const ui = getPromptUi(ctx)
	if (!ui) return Promise.resolve(undefined)
	if (ui.editor) {
		const editorTitle = options.placeholder ? `${title}\n${options.placeholder}` : title
		return withWorkingHidden(ui, () => ui.editor?.(editorTitle, options.prefill ?? "") ?? Promise.resolve(undefined))
	}
	if (ui.input) {
		return withWorkingHidden(
			ui,
			() => ui.input?.(title, options.prefill ?? options.placeholder) ?? Promise.resolve(undefined),
		)
	}
	return Promise.resolve(undefined)
}

export async function promptForm(ctx: unknown, spec: PromptFormSpec): Promise<PromptFormResult | undefined> {
	const ui = getPromptUi(ctx)
	if (!ui) return undefined
	const questions = spec.questions.map(normalizePromptFormQuestion)
	if (questions.length === 0) return undefined

	if (ui.custom) {
		const customResult = await withWorkingHidden(
			ui,
			() =>
				ui.custom?.<PromptFormResult | null>((tui, theme, _keybindings, done) =>
					createPromptFormComponent(tui, theme, questions, spec.title, spec.description, done),
				) ?? Promise.resolve(undefined),
		)
		if (customResult !== undefined) return customResult ?? undefined
	}

	return promptFormFallback(ui, questions, spec.title, spec.description)
}

function normalizePromptFormQuestion(q: PromptFormQuestion, index: number): Question {
	const type = normalizePromptFormQuestionType(q.type)
	const otherLabel = q.otherLabel?.trim()
	return {
		id: q.id,
		label: q.label || `Q${index + 1}`,
		prompt: q.prompt,
		type,
		options: (q.options ?? []).map((o) => ({ id: o.id, label: o.label, description: o.description })),
		allowOther: q.allowOther ?? false,
		otherLabel: otherLabel && otherLabel.length > 0 ? otherLabel : undefined,
		required: q.required !== false,
	}
}

function normalizePromptFormQuestionType(type: PromptFormQuestionType): QuestionType {
	const legacyType = type as string
	if (legacyType === "radio") return "single"
	if (legacyType === "checkbox") return "multi"
	return type
}

async function promptFormFallback(
	ui: PromptUi,
	questions: Question[],
	title: string | undefined,
	description: string | undefined,
): Promise<PromptFormResult | undefined> {
	const answers: Answer[] = []
	const heading = [title, description].filter(Boolean).join("\n\n")
	for (const question of questions) {
		const promptTitle = [heading, question.prompt].filter(Boolean).join("\n\n")
		if (question.type === "text") {
			const value = await withWorkingHidden(ui, () => ui.input?.(promptTitle, "") ?? Promise.resolve(undefined))
			if (!value && question.required) return { questions, answers, cancelled: true }
			if (value) answers.push({ id: question.id, value, label: value, wasCustom: true })
			continue
		}

		const choices: PromptChoiceOption[] = question.options.map((o) => ({ label: o.label, description: o.description }))
		const otherLabel = question.otherLabel ?? "Type your own answer"
		if (question.allowOther) choices.push({ label: otherLabel })
		if (question.type === "multi") {
			const selected = await promptMultiChoiceWithUi(ui, promptTitle, choices)
			if ((!selected || selected.length === 0) && question.required) return { questions, answers, cancelled: true }
			if (!selected || selected.length === 0) continue
			const values: string[] = []
			const labels: string[] = []
			const indices: number[] = []
			for (const label of selected) {
				if (label === otherLabel && question.allowOther) {
					const custom = await withWorkingHidden(
						ui,
						() => ui.input?.(`${promptTitle}\n\nYour answer:`, "") ?? Promise.resolve(undefined),
					)
					if (custom) {
						values.push(custom)
						labels.push(custom)
						indices.push(question.options.length + 1)
					}
					continue
				}
				const index = question.options.findIndex((o) => o.label === label)
				const option = question.options[index]
				if (option) {
					values.push(option.id)
					labels.push(option.label)
					indices.push(index + 1)
				}
			}
			if (values.length > 0) {
				answers.push({
					id: question.id,
					value: values.join(", "),
					label: labels.join(", "),
					wasCustom: selected.includes(otherLabel),
					values,
					labels,
					indices,
				})
			}
			continue
		}

		const selected = await promptChoiceWithUi(ui, promptTitle, choices)
		if (!selected && question.required) return { questions, answers, cancelled: true }
		if (!selected) continue
		if (selected === otherLabel && question.allowOther) {
			const custom = await withWorkingHidden(
				ui,
				() => ui.input?.(`${promptTitle}\n\nYour answer:`, "") ?? Promise.resolve(undefined),
			)
			if (!custom && question.required) return { questions, answers, cancelled: true }
			if (custom) answers.push({ id: question.id, value: custom, label: custom, wasCustom: true })
			continue
		}
		const index = question.options.findIndex((o) => o.label === selected)
		const option = question.options[index]
		if (option) {
			answers.push({ id: question.id, value: option.id, label: option.label, wasCustom: false, index: index + 1 })
		}
	}
	return { questions, answers, cancelled: false }
}

async function promptChoiceWithUi(
	ui: PromptUi,
	title: string,
	options: ReadonlyArray<PromptChoiceOption>,
): Promise<string | undefined> {
	if (!ui.select) return undefined
	return withWorkingHidden(
		ui,
		() =>
			ui.select?.(
				title,
				options.map((o) => o.label),
			) ?? Promise.resolve(undefined),
	)
}

async function promptMultiChoiceWithUi(
	ui: PromptUi,
	title: string,
	options: ReadonlyArray<PromptChoiceOption>,
): Promise<string[] | undefined> {
	if (!ui.input) return undefined
	const optionText = options
		.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` - ${o.description}` : ""}`)
		.join("\n")
	const raw = await withWorkingHidden(
		ui,
		() =>
			ui.input?.(`${title}\n\nSelect one or more:\n${optionText}`, "Numbers or labels, comma-separated") ??
			Promise.resolve(undefined),
	)
	if (!raw) return undefined
	const labels = parseMultiChoiceInput(raw, options)
	return labels.length > 0 ? labels : undefined
}

export function createPromptFormComponent(
	tui: TUI,
	theme: Theme,
	questions: Question[],
	title: string | undefined,
	description: string | undefined,
	done: (result: PromptFormResult | null) => void,
): Component {
	return createQuestionForm(tui, theme, questions, { title, description }, done)
}

function parseMultiChoiceInput(input: string, options: ReadonlyArray<PromptChoiceOption>): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	const parts = input
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean)
	for (const part of parts) {
		const numeric = Number(part)
		const option = Number.isInteger(numeric)
			? options[numeric - 1]
			: options.find((o) => o.label.toLowerCase() === part.toLowerCase())
		if (option && !seen.has(option.label)) {
			seen.add(option.label)
			out.push(option.label)
		}
	}
	return out
}
