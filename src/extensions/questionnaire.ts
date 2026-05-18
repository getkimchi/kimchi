/**
 * Questionnaire Tool — structured interactive input from the user.
 *
 * Supports four question types:
 *   - single  — radio select, pick one option (default)
 *   - multi   — checkbox, pick multiple options
 *   - text    — free-text input, no predefined options
 *   - confirm — yes/no binary choice
 *
 * Single question: simple option list.
 * Multiple questions: tab-bar navigation between questions + Submit tab.
 *
 * Based on the pi-mono SDK example (examples/extensions/questionnaire.ts)
 * but extended with additional question types and integrated as a first-class
 * harness tool for plan mode and general agent interaction.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Input, Key, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import { type Static, Type } from "typebox"

import {
	type Answer,
	type Question,
	type QuestionnaireEffect,
	type QuestionnaireEvent,
	type QuestionnaireState,
	type RenderOption,
	allRequiredAnswered,
	currentOptions,
	currentQuestion,
	initialState,
	isSubmitTab,
	reduce,
} from "./questionnaire-reducer.js"

export type { Answer, Question }

interface QuestionnaireResult {
	questions: Question[]
	answers: Answer[]
	cancelled: boolean
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional help text shown below the label" })),
})

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short tab label for multi-question flows (e.g. 'Scope', 'Priority'). Defaults to Q1, Q2, ...",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	type: Type.Optional(
		Type.Union([Type.Literal("single"), Type.Literal("multi"), Type.Literal("text"), Type.Literal("confirm")], {
			description: "Question type: single (radio, default), multi (checkbox), text (free-text), confirm (yes/no).",
		}),
	),
	options: Type.Optional(
		Type.Array(QuestionOptionSchema, {
			description: "Available choices. Required for single/multi. Ignored for text/confirm.",
		}),
	),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Add a 'Type your own answer' option. Default: true for single, false for others." }),
	),
	required: Type.Optional(Type.Boolean({ description: "Whether an answer is required. Default: true." })),
})

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "One or more questions to ask the user." }),
	header: Type.Optional(Type.String({ description: "Optional header text shown above the questions." })),
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	}
}

function normalizeQuestion(q: Static<typeof QuestionSchema>, index: number): Question {
	const type = q.type ?? "single"
	return {
		id: q.id,
		label: q.label || `Q${index + 1}`,
		prompt: q.prompt,
		type,
		options:
			type === "confirm"
				? [
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					]
				: (q.options ?? []),
		allowOther: q.allowOther ?? type === "single",
		required: q.required !== false,
	}
}

function validateQuestions(questions: Question[]): string | undefined {
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

// ─── Extension ────────────────────────────────────────────────────────────────

export default function questionnaireExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more structured questions. Use for clarifying requirements, getting preferences, or confirming decisions before acting. Supports single-select (radio), multi-select (checkbox), free-text input, and yes/no confirmation. For a single question, shows a simple option list. For multiple questions, shows a tab-based interface. Prefer this over outputting questions as plain text.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult(
					"Error: questionnaire requires interactive mode (no UI available). Rephrase your questions as text in your response instead.",
				)
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided.")
			}

			const questions = params.questions.map(normalizeQuestion)
			const validationError = validateQuestions(questions)
			if (validationError) {
				return errorResult(`Error: ${validationError}`, questions)
			}

			const isMulti = questions.length > 1

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				// ── State ──
				let state: QuestionnaireState = initialState(questions)
				let cachedLines: string[] | undefined

				const editor = new Input()
				editor.focused = true

				// ── Effects & dispatch ──
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

				// ── Text input wiring ──
				editor.onSubmit = (value: string) => dispatch({ kind: "editor-submit", value })

				// ── Input handling (pure key→event mapper) ──
				function handleInput(data: string): void {
					if (state.inputMode) {
						if (matchesKey(data, Key.escape)) {
							dispatch({ kind: "key-escape" })
							return
						}
						// Forward everything else directly to the live editor and re-render.
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
						return
					}
				}

				// ── Rendering ──
				function render(width: number): string[] {
					if (cachedLines) return cachedLines

					const lines: string[] = []
					const q = currentQuestion(state)
					const opts = currentOptions(state)

					const add = (s: string) => lines.push(truncateToWidth(s, width))
					add(theme.fg("accent", "\u2500".repeat(width)))

					// Header
					if (params.header) {
						add(` ${theme.fg("text", params.header)}`)
						lines.push("")
					}

					// Tab bar (multi-question only)
					if (isMulti) {
						const tabs: string[] = ["\u2190 "]
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === state.currentTab
							const isAnswered = state.answers.has(questions[i].id)
							const lbl = questions[i].label
							const box = isAnswered ? "\u25A0" : "\u25A1"
							const color = isAnswered ? "success" : "muted"
							const text = ` ${box} ${lbl} `
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text)
							tabs.push(`${styled} `)
						}
						const canSubmit = allRequiredAnswered(state)
						const onSubmitTab = isSubmitTab(state)
						const submitText = " \u2713 Submit "
						const submitStyled = onSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText)
						tabs.push(`${submitStyled} \u2192`)
						add(` ${tabs.join("")}`)
						lines.push("")
					}

					// Render options list helper
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
									const suffix =
										state.inputMode && q.id === state.inputQuestionId ? " \u270E" : customText ? " \u270E" : ""
									add(`${prefix}${theme.fg(color, `${box} ${i + 1}. ${labelText}${suffix}`)}`)
								} else {
									add(`${prefix}${theme.fg(color, `${box} ${i + 1}. ${opt.label}`)}`)
								}
							} else {
								const prefix = selected ? theme.fg("accent", "> ") : "  "
								const color = selected ? "accent" : "text"
								if (isOther && state.inputMode) {
									add(`${prefix}${theme.fg("accent", `${i + 1}. ${opt.label} \u270E`)}`)
								} else {
									add(`${prefix}${theme.fg(color, `${i + 1}. ${opt.label}`)}`)
								}
							}
							if (opt.description) {
								add(`     ${theme.fg("muted", opt.description)}`)
							}
						}
					}

					// Content
					if (state.inputMode && q) {
						add(theme.fg("text", ` ${q.prompt}`))
						lines.push("")
						if (opts.length > 0) renderOptions()
						lines.push("")
						add(theme.fg("muted", " Your answer:"))
						for (const line of editor.render(width - 2)) {
							add(` ${line}`)
						}
						lines.push("")
						add(theme.fg("dim", " Enter to submit \u2022 Esc to cancel"))
					} else if (isSubmitTab(state)) {
						// Submit tab
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
					} else if (q && q.type === "text") {
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
							help = isMulti
								? " Tab/\u2190\u2192 navigate \u2022 Enter submit \u2022 Esc cancel"
								: " Enter submit \u2022 Esc cancel"
						} else if (q?.type === "multi") {
							help = isMulti
								? " Tab/\u2190\u2192 navigate \u2022 \u2191\u2193 select \u2022 Space toggle \u2022 Enter submit \u2022 Esc cancel"
								: " \u2191\u2193 navigate \u2022 Space toggle \u2022 Enter submit \u2022 Esc cancel"
						} else if (q?.type === "text") {
							help = isMulti
								? " Tab/\u2190\u2192 navigate \u2022 Type answer \u2022 Enter edit \u2022 Esc cancel"
								: " Type answer \u2022 Enter edit \u2022 Esc cancel"
						} else {
							help = isMulti
								? " Tab/\u2190\u2192 navigate \u2022 \u2191\u2193 select \u2022 Enter confirm \u2022 Esc cancel"
								: " \u2191\u2193 navigate \u2022 Enter select \u2022 Esc cancel"
						}
						add(theme.fg("dim", help))
					}
					add(theme.fg("accent", "\u2500".repeat(width)))

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
			})

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire." }],
					details: result,
				}
			}

			const text = formatAnswerText(questions, result.answers)
			return {
				content: [{ type: "text", text }],
				details: result,
			}
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || []
			const count = qs.length
			const labels = qs.map((q) => q.label || q.id).join(", ")
			let text = theme.fg("toolTitle", theme.bold("questionnaire "))
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`)
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`)
			}
			return new Text(text, 0, 0)
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined
			if (!details) {
				const first = result.content[0]
				return new Text(first?.type === "text" ? first.text : "", 0, 0)
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0)
			}
			const lines = details.answers.map((a) => {
				if (a.values && a.labels) {
					const items = a.labels
						.map((l, i) => {
							const idx = a.indices?.[i]
							return idx ? `${idx}. ${l}` : l
						})
						.join(", ")
					return `${theme.fg("success", "\u2713 ")}${theme.fg("accent", a.id)}: ${items}`
				}
				if (a.wasCustom) {
					return `${theme.fg("success", "\u2713 ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label
				return `${theme.fg("success", "\u2713 ")}${theme.fg("accent", a.id)}: ${display}`
			})
			return new Text(lines.join("\n"), 0, 0)
		},
	})
}
