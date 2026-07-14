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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Text, truncateToWidth } from "@earendil-works/pi-tui"
import { type Static, Type } from "typebox"

import { createToolVisibility } from "../prompt-construction/tool-visibility.js"
import { withWorkingHidden } from "../ui.js"
import { type QuestionnaireResult, promptQuestionnaireFallback } from "./questionnaire-fallback.js"
import { createQuestionForm } from "./questionnaire-form.js"
import { type Answer, type Question, type QuestionType, YES_NO_OPTIONS } from "./questionnaire-reducer.js"

// ─── Schema ───────────────────────────────────────────────────────────────────

const QuestionOptionSchema = Type.Object({
	id: Type.String({
		description: "Stable unique value returned when this option is selected. Pick short snake-case ids.",
	}),
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
		Type.String({
			description:
				"Question type. Must be 'single' (one choice, default), 'multi' (multiple choices), 'text' (free-text), or 'confirm' (yes/no).",
			pattern: "^(single|multi|text|confirm)$",
		}),
	),
	options: Type.Optional(
		Type.Array(QuestionOptionSchema, {
			description: "Available choices. Required for single/multi. Omit for text and confirm; confirm is always Yes/No.",
		}),
	),
	allowOther: Type.Optional(
		Type.Boolean({
			description:
				"For single/multi questions only. Add a 'Type your own answer' option. Must be omitted for confirm. Default: true for single, false for others.",
		}),
	),
	required: Type.Optional(Type.Boolean({ description: "Whether an answer is required. Default: true." })),
})

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "One or more questions to ask the user." }),
	header: Type.Optional(Type.String({ description: "Optional header text shown above the questions." })),
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize an agent-supplied question type to the canonical vocabulary.
 *  Only an omitted (undefined) type defaults to "single"; any other string must
 *  be one of single|multi|text|confirm (case-insensitive). Unknown strings throw
 *  rather than silently becoming "single" — there is one vocabulary, no aliases.
 *  Normal tool calls never reach the throw because the TypeBox pattern rejects
 *  bad types first; it guards direct/internal callers that bypass the schema. */
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
		required: q.required !== false,
	}
}

function validateRawQuestions(questions: Static<typeof QuestionSchema>[]): string | undefined {
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
	// The questionnaire tool drives a multi-question TUI form. When no UI is
	// attached the execute body would return an error — worse, the model can
	// retry the same call because the tool stays visible. Hide it from the
	// system prompt as soon as we know there is no UI so the LLM never picks
	// it. The execute body keeps the runtime check as defense-in-depth.
	const visibility = createToolVisibility(pi)
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.hasUI) {
			visibility.enable(["questionnaire"])
		} else {
			visibility.disable(["questionnaire"])
		}
	})

	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more structured questions. Use for clarifying requirements, getting preferences, or confirming decisions before acting. Supports single-select, multi-select, free-text input, and yes/no confirmation. For a single question, shows a simple option list. For multiple questions, shows a tab-based interface. Never call this tool twice in the same turn — batch all questions you need now into one call, and only ask follow-ups after reading the user's response. Prefer this over outputting questions as plain text.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided.")
			}

			const rawValidationError = validateRawQuestions(params.questions)
			if (rawValidationError) {
				return errorResult(`Error: ${rawValidationError}`)
			}

			const questions = params.questions.map(normalizeQuestion)
			const validationError = validateQuestions(questions)
			if (validationError) {
				return errorResult(`Error: ${validationError}`, questions)
			}

			if (!ctx.hasUI) {
				// Defense-in-depth: the session_start handler should have hidden
				// the tool from the system prompt already. If we got here anyway
				// (tool hidden mid-session, or schema leaked) make the failure
				// an explicit "do not retry" steer so the model doesn't loop on it.
				return errorResult(
					"questionnaire is unavailable in this session: it requires an interactive UI and none is attached (the harness is running in a non-interactive mode such as --print, --mode json|rpc|acp, or a headless subprocess). Do NOT call questionnaire again in this session. Ask the user clarifying questions as plain text in your reply instead.",
				)
			}

			let result: QuestionnaireResult
			if (ctx.mode !== "tui") {
				result = await promptQuestionnaireFallback(ctx.ui, questions)
			} else {
				result = await withWorkingHidden(ctx, () =>
					ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) =>
						createQuestionForm(tui, theme, questions, { title: params.header }, done),
					),
				)
			}

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
