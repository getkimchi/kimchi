/**
 * Shared questionnaire form renderer.
 *
 * One `ui.custom` component, driven by the questionnaire reducer, used by both
 * the generic `questionnaire` tool and ferment's `ask_user` prompt UI. The
 * reducer, key handling, and effect application were already identical between
 * the two call sites; this module also unifies the rendering so there is a
 * single look-and-feel (and a single place to change it).
 *
 * Callers differ only in their header content: the `questionnaire` tool passes
 * a single `title`; ferment's `promptForm` passes `title` + `description`.
 */

import { type Theme, getSelectListTheme } from "@earendil-works/pi-coding-agent"
import { Editor, Key, type TUI, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui"
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
} from "./questionnaire-reducer.js"

export interface QuestionFormResult {
	questions: Question[]
	answers: Answer[]
	cancelled: boolean
}

export interface QuestionFormHeader {
	/** Bold heading line shown above the questions. */
	title?: string
	/** Muted context line(s) shown beneath the title. */
	description?: string
}

/** Build the shared questionnaire `ui.custom` component. The component owns the
 *  reducer state, maps keys to reducer events, and renders the form. `done` is
 *  invoked exactly once with the collected answers (or `cancelled: true`). */
export function createQuestionForm(
	tui: TUI,
	theme: Theme,
	questions: Question[],
	header: QuestionFormHeader,
	done: (result: QuestionFormResult) => void,
): Component {
	let state: QuestionnaireState = initialState(questions)
	let cachedLines: string[] | undefined
	let cachedWidth = 0
	const isMulti = questions.length > 1
	const editorTheme = {
		borderColor: (s: string) => theme.fg("muted", s),
		selectList: getSelectListTheme(),
	}
	const editor = new Editor(tui, editorTheme)
	editor.focused = true

	function applyEffects(effects: QuestionnaireEffect[]): void {
		for (const eff of effects) {
			switch (eff.kind) {
				case "render":
					cachedLines = undefined
					tui.requestRender()
					break
				case "editor-set-text":
					editor.setText(eff.text)
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
		if (cachedLines && cachedWidth === width) return cachedLines

		const lines: string[] = []
		const q = currentQuestion(state)
		const opts = currentOptions(state)
		const add = (s: string) => {
			for (const line of wrapTextWithAnsi(s, width)) {
				lines.push(line)
			}
		}
		add(theme.fg("accent", "─".repeat(width)))

		if (header.title || header.description) {
			if (header.title) add(` ${theme.fg("text", theme.bold(header.title))}`)
			if (header.description) {
				for (const line of wrapTextWithAnsi(header.description, Math.max(1, width - 2)))
					add(` ${theme.fg("muted", line)}`)
			}
			lines.push("")
		}

		if (isMulti) {
			const tabs: string[] = ["← "]
			for (let i = 0; i < questions.length; i++) {
				const isActive = i === state.currentTab
				const isAnswered = state.answers.has(questions[i].id)
				const lbl = questions[i].label
				const box = isAnswered ? "■" : "□"
				const color = isAnswered ? "success" : "muted"
				const text = ` ${box} ${lbl} `
				const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text)
				tabs.push(`${styled} `)
			}
			const canSubmit = allRequiredAnswered(state)
			const onSubmitTab = isSubmitTab(state)
			const submitText = " ✓ Submit "
			const submitStyled = onSubmitTab
				? theme.bg("selectedBg", theme.fg("text", submitText))
				: theme.fg(canSubmit ? "success" : "dim", submitText)
			tabs.push(`${submitStyled} →`)
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
						const suffix = state.inputMode && q.id === state.inputQuestionId ? " ✎" : customText ? " ✎" : ""
						add(`${prefix}${theme.fg(color, `${box} ${i + 1}. ${labelText}${suffix}`)}`)
					} else {
						add(`${prefix}${theme.fg(color, `${box} ${i + 1}. ${opt.label}`)}`)
					}
				} else {
					const prefix = selected ? theme.fg("accent", "> ") : "  "
					const color = selected ? "accent" : "text"
					if (isOther && state.inputMode) {
						add(`${prefix}${theme.fg("accent", `${i + 1}. ${opt.label} ✎`)}`)
					} else {
						add(`${prefix}${theme.fg(color, `${i + 1}. ${opt.label}`)}`)
					}
				}
				if (opt.description) {
					for (const descLine of wrapTextWithAnsi(opt.description, Math.max(1, width - 8))) {
						add(`     ${theme.fg("muted", descLine)}`)
					}
				}
			}
		}

		if (state.inputMode && q) {
			add(theme.fg("text", ` ${q.prompt}`))
			lines.push("")
			if (opts.length > 0) renderOptions()
			lines.push("")
			add(theme.fg("muted", " Your answer:"))
			for (const line of editor.render(width - 2)) add(` ${line}`)
			lines.push("")
			add(theme.fg("dim", " Enter to submit • Shift+Enter for newline • Esc to cancel"))
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
			add(theme.fg("text", ` ${q.prompt}`))
			lines.push("")
			const existing = state.answers.get(q.id)
			if (existing) {
				add(theme.fg("muted", ` Current: ${existing.label}`))
				lines.push("")
			}
			add(theme.fg("dim", " Press Enter or start typing to answer"))
		} else if (q) {
			add(theme.fg("text", ` ${q.prompt}`))
			lines.push("")
			renderOptions()
		}

		lines.push("")
		if (!state.inputMode) {
			let help: string
			if (isSubmitTab(state)) {
				help = isMulti ? " Tab/←→ navigate • Enter submit • Esc cancel" : " Enter submit • Esc cancel"
			} else if (q?.type === "multi") {
				help = isMulti
					? " Tab/←→ navigate • ↑↓ select • Space toggle • Enter submit • Esc cancel"
					: " ↑↓ navigate • Space toggle • Enter submit • Esc cancel"
			} else if (q?.type === "text") {
				help = isMulti
					? " Tab/←→ navigate • Type answer • Enter edit • Esc cancel"
					: " Type answer • Enter edit • Esc cancel"
			} else {
				help = isMulti
					? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
					: " ↑↓ navigate • Enter select • Esc cancel"
			}
			add(theme.fg("dim", help))
		}
		add(theme.fg("accent", "─".repeat(width)))

		cachedLines = lines
		cachedWidth = width
		return lines
	}

	return {
		render,
		invalidate: () => {
			cachedLines = undefined
			cachedWidth = 0
		},
		handleInput,
	}
}
