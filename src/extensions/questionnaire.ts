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
import { Editor, type EditorTheme, Key, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import { type Static, Type } from "typebox"

// ─── Types ────────────────────────────────────────────────────────────────────

type QuestionType = "single" | "multi" | "text" | "confirm"

interface QuestionOption {
	value: string
	label: string
	description?: string
}

interface Question {
	id: string
	label: string
	prompt: string
	type: QuestionType
	options: QuestionOption[]
	allowOther: boolean
	required: boolean
}

type RenderOption = QuestionOption & { isOther?: boolean }

interface Answer {
	id: string
	value: string
	label: string
	wasCustom: boolean
	index?: number
	// multi-select fields
	values?: string[]
	labels?: string[]
	indices?: number[]
}

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
	const type: QuestionType = q.type ?? "single"
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
			const totalTabs = questions.length + 1 // questions + Submit

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				// ── State ──
				let currentTab = 0
				let optionIndex = 0
				let inputMode = false
				let inputQuestionId: string | null = null
				let cachedLines: string[] | undefined
				const answers = new Map<string, Answer>()
				// multi-select toggles: questionId → Set<optionIndex>
				const multiToggles = new Map<string, Set<number>>()
				// multi-select custom "Other" text: questionId → user-typed string
				const multiCustomText = new Map<string, string>()

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				}
				const editor = new Editor(tui, editorTheme)

				// ── Helpers ──
				function refresh(): void {
					cachedLines = undefined
					tui.requestRender()
				}

				function submit(cancelled: boolean): void {
					done({ questions, answers: Array.from(answers.values()), cancelled })
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab]
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion()
					if (!q || q.type === "text") return []
					const opts: RenderOption[] = [...q.options]
					if (q.allowOther) {
						opts.push({ value: "__other__", label: "Type your own answer", isOther: true })
					}
					return opts
				}

				function allRequiredAnswered(): boolean {
					return questions.every((q) => !q.required || answers.has(q.id))
				}

				function advanceAfterAnswer(): void {
					if (!isMulti) {
						submit(false)
						return
					}
					if (currentTab < questions.length - 1) {
						currentTab++
					} else {
						currentTab = questions.length // Submit tab
					}
					optionIndex = 0
					refresh()
				}

				function saveAnswer(
					questionId: string,
					value: string,
					label: string,
					wasCustom: boolean,
					index?: number,
				): void {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index })
				}

				function saveMultiAnswer(q: Question): void {
					const toggled = multiToggles.get(q.id) ?? new Set()
					const values: string[] = []
					const labels: string[] = []
					const indices: number[] = []
					for (const idx of toggled) {
						if (idx < q.options.length) {
							values.push(q.options[idx].value)
							labels.push(q.options[idx].label)
							indices.push(idx + 1)
						}
					}
					const otherIdx = q.options.length
					const customText = multiCustomText.get(q.id)
					const otherToggled = toggled.has(otherIdx) && !!customText
					if (otherToggled && customText) {
						values.push(customText)
						labels.push(customText)
						indices.push(otherIdx + 1)
					}
					if (values.length > 0) {
						answers.set(q.id, {
							id: q.id,
							value: values.join(", "),
							label: labels.join(", "),
							wasCustom: otherToggled,
							values,
							labels,
							indices,
						})
					} else {
						answers.delete(q.id)
					}
				}

				// Editor submit callback for free-text input
				editor.onSubmit = (value: string) => {
					if (!inputQuestionId) return
					const trimmed = value.trim() || "(no response)"
					const q = questions.find((x) => x.id === inputQuestionId)
					if (q?.type === "multi") {
						multiCustomText.set(q.id, trimmed)
						if (!multiToggles.has(q.id)) multiToggles.set(q.id, new Set())
						multiToggles.get(q.id)?.add(q.options.length)
						saveMultiAnswer(q)
						inputMode = false
						inputQuestionId = null
						editor.setText("")
						refresh()
						return
					}
					saveAnswer(inputQuestionId, trimmed, trimmed, true)
					inputMode = false
					inputQuestionId = null
					editor.setText("")
					advanceAfterAnswer()
				}

				// ── Input handling ──
				function handleInput(data: string): void {
					// Input mode: route to editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false
							inputQuestionId = null
							editor.setText("")
							refresh()
							return
						}
						editor.handleInput(data)
						refresh()
						return
					}

					const q = currentQuestion()
					const opts = currentOptions()

					// Tab navigation (multi-question only)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs
							optionIndex = 0
							refresh()
							return
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs
							optionIndex = 0
							refresh()
							return
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allRequiredAnswered()) {
							submit(false)
						} else if (matchesKey(data, Key.escape)) {
							submit(true)
						}
						return
					}

					// Text-type question: enter input mode immediately
					if (q && q.type === "text" && !inputMode) {
						if (matchesKey(data, Key.enter)) {
							inputMode = true
							inputQuestionId = q.id
							// Pre-fill with existing answer if editing
							const existing = answers.get(q.id)
							editor.setText(existing?.wasCustom ? existing.value : "")
							refresh()
							return
						}
						if (matchesKey(data, Key.escape)) {
							submit(true)
							return
						}
						// Start typing immediately
						if (data.length === 1 && data >= " ") {
							inputMode = true
							inputQuestionId = q.id
							editor.setText("")
							editor.handleInput(data)
							refresh()
							return
						}
						return
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1)
						refresh()
						return
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1)
						refresh()
						return
					}

					// Multi-select: space to toggle
					if (q && q.type === "multi" && data === " ") {
						if (!multiToggles.has(q.id)) multiToggles.set(q.id, new Set())
						const toggled = multiToggles.get(q.id) ?? new Set()
						const opt = opts[optionIndex]
						// Other rows can be toggled with Space only after a custom value has been typed.
						const canToggleOther = opt?.isOther && multiCustomText.has(q.id)
						if (opt && (!opt.isOther || canToggleOther)) {
							if (toggled.has(optionIndex)) {
								toggled.delete(optionIndex)
							} else {
								toggled.add(optionIndex)
							}
							saveMultiAnswer(q)
							refresh()
						}
						return
					}

					// Multi-select: enter on the Other row opens the free-text editor when
					// no committed text exists yet (or when Other was toggled off — useful for
					// re-editing). When Other already has text and is toggled on, fall through
					// so Enter advances/submits like the regular rows.
					if (q && q.type === "multi" && matchesKey(data, Key.enter) && opts[optionIndex]?.isOther) {
						const toggled = multiToggles.get(q.id) ?? new Set()
						const otherIdx = q.options.length
						const committed = multiCustomText.has(q.id) && toggled.has(otherIdx)
						if (!committed) {
							inputMode = true
							inputQuestionId = q.id
							editor.setText(multiCustomText.get(q.id) ?? "")
							refresh()
							return
						}
					}

					// Multi-select: enter submits current selections
					if (q && q.type === "multi" && matchesKey(data, Key.enter)) {
						saveMultiAnswer(q)
						advanceAfterAnswer()
						return
					}

					// Single/confirm: enter selects
					if (matchesKey(data, Key.enter) && q) {
						const opt = opts[optionIndex]
						if (opt?.isOther) {
							inputMode = true
							inputQuestionId = q.id
							editor.setText("")
							refresh()
							return
						}
						if (opt) {
							saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1)
							advanceAfterAnswer()
						}
						return
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						submit(true)
					}
				}

				// ── Rendering ──
				function render(width: number): string[] {
					if (cachedLines) return cachedLines

					const lines: string[] = []
					const q = currentQuestion()
					const opts = currentOptions()

					const add = (s: string) => lines.push(truncateToWidth(s, width))
					add(theme.fg("accent", "\u2500".repeat(width)))

					// Header
					if (params.header && currentTab === 0 && !inputMode) {
						add(` ${theme.fg("text", params.header)}`)
						lines.push("")
					}

					// Tab bar (multi-question only)
					if (isMulti) {
						const tabs: string[] = ["\u2190 "]
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab
							const isAnswered = answers.has(questions[i].id)
							const lbl = questions[i].label
							const box = isAnswered ? "\u25A0" : "\u25A1"
							const color = isAnswered ? "success" : "muted"
							const text = ` ${box} ${lbl} `
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text)
							tabs.push(`${styled} `)
						}
						const canSubmit = allRequiredAnswered()
						const isSubmitTab = currentTab === questions.length
						const submitText = " \u2713 Submit "
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText)
						tabs.push(`${submitStyled} \u2192`)
						add(` ${tabs.join("")}`)
						lines.push("")
					}

					// Render options list helper
					function renderOptions(): void {
						const toggled = q ? (multiToggles.get(q.id) ?? new Set()) : new Set()
						const customText = q ? multiCustomText.get(q.id) : undefined
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i]
							const selected = i === optionIndex
							const isOther = opt.isOther === true

							if (q?.type === "multi") {
								const checked = toggled.has(i)
								const box = checked ? "[x]" : "[ ]"
								const prefix = selected ? theme.fg("accent", "> ") : "  "
								const color = selected ? "accent" : "text"
								if (isOther) {
									const labelText = customText ?? opt.label
									const suffix = inputMode && q.id === inputQuestionId ? " \u270E" : customText ? " \u270E" : ""
									add(`${prefix}${theme.fg(color, `${box} ${i + 1}. ${labelText}${suffix}`)}`)
								} else {
									add(`${prefix}${theme.fg(color, `${box} ${i + 1}. ${opt.label}`)}`)
								}
							} else {
								const prefix = selected ? theme.fg("accent", "> ") : "  "
								const color = selected ? "accent" : "text"
								if (isOther && inputMode) {
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
					if (inputMode && q) {
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
					} else if (currentTab === questions.length) {
						// Submit tab
						add(theme.fg("accent", theme.bold(" Ready to submit")))
						lines.push("")
						for (const question of questions) {
							const answer = answers.get(question.id)
							if (answer) {
								const prefix = answer.wasCustom ? "(wrote) " : ""
								const display = answer.values ? (answer.labels?.join(", ") ?? answer.label) : prefix + answer.label
								add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", display)}`)
							} else if (!question.required) {
								add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("dim", "(skipped)")}`)
							}
						}
						lines.push("")
						if (allRequiredAnswered()) {
							add(theme.fg("success", " Press Enter to submit"))
						} else {
							const missing = questions
								.filter((q) => q.required && !answers.has(q.id))
								.map((q) => q.label)
								.join(", ")
							add(theme.fg("warning", ` Unanswered: ${missing}`))
						}
					} else if (q && q.type === "text") {
						add(theme.fg("text", ` ${q.prompt}`))
						lines.push("")
						const existing = answers.get(q.id)
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
					if (!inputMode) {
						let help: string
						if (q?.type === "multi") {
							help = isMulti
								? " Tab/\u2190\u2192 navigate \u2022 \u2191\u2193 select \u2022 Space toggle \u2022 Enter submit \u2022 Esc cancel"
								: " \u2191\u2193 navigate \u2022 Space toggle \u2022 Enter submit \u2022 Esc cancel"
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
