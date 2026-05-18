import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent"
import { Input, Key, type TUI, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import type { Component } from "@earendil-works/pi-tui"
import {
	type Answer,
	type Question,
	type QuestionnaireEffect,
	type QuestionnaireEvent,
	type QuestionnaireState,
	allRequiredAnswered,
	currentOptions,
	currentQuestion,
	initialState,
	isSubmitTab,
	reduce,
} from "../questionnaire-reducer.js"

export type PromptUi = {
	select?: (title: string, options: string[]) => Promise<string | undefined>
	input?: (title: string, placeholder?: string) => Promise<string | undefined>
	custom?: ExtensionUIContext["custom"]
	setWorkingVisible?: (visible: boolean) => void
}

export interface PromptChoiceOption {
	label: string
	description?: string
}

export type PromptFormQuestionType = "radio" | "checkbox" | "text"

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
	ui.setWorkingVisible?.(false)
	try {
		return await fn()
	} finally {
		ui.setWorkingVisible?.(true)
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
	const type = q.type === "radio" ? "single" : q.type === "checkbox" ? "multi" : "text"
	return {
		id: q.id,
		label: q.label || `Q${index + 1}`,
		prompt: q.prompt,
		type,
		options: (q.options ?? []).map((o) => ({ value: o.id, label: o.label, description: o.description })),
		allowOther: q.allowOther ?? false,
		required: q.required !== false,
	}
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
		const otherLabel = "Type your own answer"
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
					values.push(option.value)
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
			answers.push({ id: question.id, value: option.value, label: option.label, wasCustom: false, index: index + 1 })
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

function createPromptFormComponent(
	tui: TUI,
	theme: Theme,
	questions: Question[],
	title: string | undefined,
	description: string | undefined,
	done: (result: PromptFormResult | null) => void,
): Component {
	let state: QuestionnaireState = initialState(questions)
	let cachedLines: string[] | undefined
	const isMulti = questions.length > 1
	const editor = new Input()
	editor.focused = true

	function applyEffects(effects: QuestionnaireEffect[]): void {
		for (const eff of effects) {
			switch (eff.kind) {
				case "render":
					cachedLines = undefined
					tui.requestRender()
					break
				case "editor-set-text":
					editor.setValue(eff.text)
					break
				case "editor-handle-input":
					editor.handleInput(eff.data)
					break
				case "done":
					done({ questions, answers: Array.from(state.answers.values()), cancelled: eff.cancelled })
					break
			}
		}
	}

	function dispatch(event: QuestionnaireEvent): void {
		const result = reduce(state, event)
		state = result.state
		applyEffects(result.effects)
	}

	editor.onSubmit = (value: string) => dispatch({ kind: "editor-submit", value })

	function handleInput(data: string): void {
		if (state.inputMode) {
			if (matchesKey(data, Key.escape)) {
				dispatch({ kind: "key-escape" })
				return
			}
			editor.handleInput(data)
			cachedLines = undefined
			tui.requestRender()
			return
		}

		if (matchesKey(data, Key.up)) {
			dispatch({ kind: "key-up" })
			return
		}
		if (matchesKey(data, Key.down)) {
			dispatch({ kind: "key-down" })
			return
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			dispatch({ kind: "key-right" })
			return
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			dispatch({ kind: "key-left" })
			return
		}
		if (matchesKey(data, Key.enter)) {
			dispatch({ kind: "key-enter" })
			return
		}
		if (matchesKey(data, Key.escape)) {
			dispatch({ kind: "key-escape" })
			return
		}
		if (data === " ") {
			dispatch({ kind: "key-space" })
			return
		}
		if (data.length === 1 && data >= " ") {
			dispatch({ kind: "char-typed", char: data })
		}
	}

	function render(width: number): string[] {
		if (cachedLines) return cachedLines

		const lines: string[] = []
		const q = currentQuestion(state)
		const opts = currentOptions(state)
		const add = (s: string) => lines.push(truncateToWidth(s, width))
		const questionTitle = q ? `${isMulti ? `[${q.label}/${questions.length}] ` : ""}${q.prompt}` : ""
		add(theme.fg("accent", "─".repeat(width)))

		if (title || description) {
			if (title) add(` ${theme.fg("text", theme.bold(title))}`)
			if (description) {
				for (const line of wrapWords(description, width - 2)) add(` ${theme.fg("muted", line)}`)
			}
			lines.push("")
		}

		if (isMulti) {
			const tabs: string[] = ["<- "]
			for (let i = 0; i < questions.length; i++) {
				const isActive = i === state.currentTab
				const isAnswered = state.answers.has(questions[i].id)
				const lbl = questions[i].label
				const box = isAnswered ? "[x]" : "[ ]"
				const color = isAnswered ? "success" : "muted"
				const text = ` ${box} ${lbl} `
				const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text)
				tabs.push(`${styled} `)
			}
			const canSubmit = allRequiredAnswered(state)
			const onSubmitTab = isSubmitTab(state)
			const submitText = " Submit "
			const submitStyled = onSubmitTab
				? theme.bg("selectedBg", theme.fg("text", submitText))
				: theme.fg(canSubmit ? "success" : "dim", submitText)
			tabs.push(`${submitStyled} ->`)
			add(` ${tabs.join("")}`)
			lines.push("")
		}

		function renderOptions(): void {
			const toggled = q ? (state.multiToggles.get(q.id) ?? new Set()) : new Set()
			const customText = q ? state.multiCustomText.get(q.id) : undefined
			for (let i = 0; i < opts.length; i++) {
				const opt = opts[i]
				const selected = i === state.optionIndex
				const isOther = opt.isOther === true

				if (q?.type === "multi") {
					const checked = toggled.has(i)
					const box = checked ? "[x]" : "[ ]"
					const prefix = selected ? theme.fg("accent", "> ") : "  "
					const color = selected ? "accent" : "text"
					if (isOther) {
						const labelText = customText ?? opt.label
						const suffix = state.inputMode && q.id === state.inputQuestionId ? " *" : customText ? " *" : ""
						add(`${prefix}${theme.fg(color, `${box} ${i + 1}. ${labelText}${suffix}`)}`)
					} else {
						add(`${prefix}${theme.fg(color, `${box} ${i + 1}. ${opt.label}`)}`)
					}
				} else {
					const prefix = selected ? theme.fg("accent", "> ") : "  "
					const color = selected ? "accent" : "text"
					if (isOther && state.inputMode) {
						add(`${prefix}${theme.fg("accent", `${i + 1}. ${opt.label} *`)}`)
					} else {
						add(`${prefix}${theme.fg(color, `${i + 1}. ${opt.label}`)}`)
					}
				}
				if (opt.description) {
					for (const descLine of wrapWords(opt.description, Math.max(12, width - 8))) {
						add(`     ${theme.fg("muted", descLine)}`)
					}
				}
			}
		}

		if (state.inputMode && q) {
			add(theme.fg("text", ` ${questionTitle}`))
			lines.push("")
			if (opts.length > 0) renderOptions()
			lines.push("")
			add(theme.fg("muted", " Your answer:"))
			for (const line of editor.render(width - 2)) add(` ${line}`)
			lines.push("")
			add(theme.fg("dim", " Enter to submit | Esc to cancel"))
		} else if (isSubmitTab(state)) {
			add(theme.fg("accent", theme.bold(" Ready to submit")))
			lines.push("")
			for (const question of questions) {
				const answer = state.answers.get(question.id)
				if (answer) {
					const prefix = answer.wasCustom ? "(wrote) " : ""
					const display = answer.values ? (answer.labels?.join(", ") ?? answer.label) : prefix + answer.label
					add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", display)}`)
				} else if (!question.required) {
					add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("dim", "(skipped)")}`)
				}
			}
			lines.push("")
			if (allRequiredAnswered(state)) {
				add(theme.fg("success", " Press Enter to submit"))
			} else {
				const missing = questions
					.filter((qq) => qq.required && !state.answers.has(qq.id))
					.map((qq) => qq.label)
					.join(", ")
				add(theme.fg("warning", ` Unanswered: ${missing}`))
			}
		} else if (q?.type === "text") {
			add(theme.fg("text", ` ${questionTitle}`))
			lines.push("")
			const existing = state.answers.get(q.id)
			if (existing) {
				add(theme.fg("muted", ` Current: ${existing.label}`))
				lines.push("")
			}
			add(theme.fg("dim", " Press Enter or start typing to answer"))
		} else if (q) {
			add(theme.fg("text", ` ${questionTitle}`))
			lines.push("")
			renderOptions()
		}

		lines.push("")
		if (!state.inputMode) {
			let help: string
			if (isSubmitTab(state)) {
				help = isMulti ? " Tab/Shift+Tab move | Enter submit | Esc cancel" : " Enter submit | Esc cancel"
			} else if (q?.type === "multi") {
				help = isMulti
					? " Tab/Shift+Tab move | Up/Down option | Space toggle | Enter advance | Esc cancel"
					: " Up/Down option | Space toggle | Enter submit | Esc cancel"
			} else if (q?.type === "text") {
				help = isMulti
					? " Tab/Shift+Tab move | Type answer | Enter edit | Esc cancel"
					: " Type answer | Enter edit | Esc cancel"
			} else {
				help = isMulti
					? " Tab/Shift+Tab move | Up/Down option | Enter select/advance | Esc cancel"
					: " Up/Down option | Enter select | Esc cancel"
			}
			add(theme.fg("dim", help))
		}
		add(theme.fg("accent", "─".repeat(width)))

		cachedLines = lines
		return lines
	}

	return {
		render,
		invalidate: () => {
			cachedLines = undefined
		},
		handleInput,
	}
}

function wrapWords(text: string, width: number): string[] {
	const limit = Math.max(8, width)
	const words = text.trim().split(/\s+/).filter(Boolean)
	if (words.length === 0) return [""]

	const lines: string[] = []
	let current = ""
	for (const word of words) {
		if (word.length > limit) {
			if (current) {
				lines.push(current)
				current = ""
			}
			for (let i = 0; i < word.length; i += limit) lines.push(word.slice(i, i + limit))
			continue
		}
		if (!current) {
			current = word
		} else if (current.length + 1 + word.length <= limit) {
			current += ` ${word}`
		} else {
			lines.push(current)
			current = word
		}
	}
	if (current) lines.push(current)
	return lines
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
