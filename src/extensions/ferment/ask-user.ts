/**
 * Ask-user primitive — the single decision-point routing layer.
 *
 * Replaces ad-hoc `ctx.ui?.select(...)` calls scattered across tool handlers
 * with one function that handles three audiences:
 *
 *   1. Interactive sessions (plan / exec / auto with a TUI attached) — routes
 *      to a richer TUI prompt. The user picks or writes; we return structured
 *      data.
 *   2. One-shot sessions (no human at the keyboard) — routes to an Opus judge
 *      that stands in for the user. The judge sees the ferment goal + success
 *      criteria + current phase/step + question + options, picks one with a
 *      rationale.
 *   3. Headless with no judge available — returns `{ failed: true }` and the
 *      caller is responsible for handling (typically by abandoning the
 *      ferment in one-shot mode).
 *
 * The agent-callable `ask_user` tool wraps this with a tool-error layer that
 * abandons the ferment when the judge can't be reached in one-shot mode.
 * Internal callers (plan-mode dropdowns, escalation, propose_scoping) check
 * the `failed` flag and degrade gracefully.
 *
 * Detection of one-shot mode comes from the `ferment-oneshot` PI flag (set at
 * session boot by /ferment one-shot or --ferment-oneshot). There is no
 * `ferment.mode === "one-shot"` — modes are plan/exec/auto. The flag is
 * orthogonal.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Ferment } from "../../ferment/types.js"
import { type JudgeApiResult, judgeApiCall } from "./judge.js"
import { promptForm } from "./prompt-ui.js"
import type { FermentRuntime } from "./runtime.js"
import type { FermentUi } from "./ui.js"

export interface AskUserOption {
	/** Stable id the agent (or judge) returns. */
	id: string
	/** Human-readable label shown in the TUI. */
	label: string
	/** Optional supporting context shown beneath the label and given to the
	 *  judge in one-shot mode. Keep it short. */
	description?: string
}

export type AskUserAnsweredBy = "user" | "judge"
export type AskUserResponseType = "single" | "multi" | "text"
export type AskUserQuestionType = "radio" | "checkbox" | "text"

export interface AskUserQuestion {
	id: string
	type: AskUserQuestionType
	prompt: string
	label?: string
	options?: AskUserOption[]
	allowOther?: boolean
	required?: boolean
	placeholder?: string
}

export interface AskUserAnswer {
	id: string
	type: AskUserQuestionType
	/** Single value for radio/text, or comma-joined values for checkbox. */
	value: string
	/** Display label for radio/text, or comma-joined labels for checkbox. */
	label: string
	/** True when the answer came from free text / Other. */
	wasCustom: boolean
	/** Checkbox values. */
	values?: string[]
	/** Checkbox display labels. */
	labels?: string[]
}

export interface AskUserSuccess {
	failed?: false
	/** Shape of answer requested from the user/judge. */
	response_type: AskUserResponseType | "form"
	/** The selected option's `id`, for single-choice questions. */
	choice?: string
	/** Selected option ids, for multi-select questions. */
	choices?: string[]
	/** User/judge-written answer, for text questions. */
	text?: string
	/** One or more structured answers, for form questions. */
	answers?: AskUserAnswer[]
	/** Who answered: "user" in interactive sessions, "judge" in one-shot. */
	answered_by: AskUserAnsweredBy
	/** Present when `answered_by === "judge"` — the model's one-line rationale. */
	rationale?: string
}

export interface AskUserFailure {
	failed: true
	/** Stable categorical reason so callers can branch / log uniformly. */
	reason: "no_ui_no_judge" | "judge_unavailable" | "judge_unparseable" | "user_cancelled" | "invalid_choice"
	/** Human-readable detail for inclusion in tool errors. */
	detail: string
}

export type AskUserResponse = AskUserSuccess | AskUserFailure

export interface AskUserOverrides {
	askJudge?: typeof askJudge
	askJudgeForm?: typeof askJudgeForm
}

export interface AskUserContext {
	ferment: Ferment
	pi: ExtensionAPI
	/** TUI hook. Accepts `Partial<FermentUi>` (matches `StepUiContext` /
	 *  `PhaseUiContext`) — the only method we actually read is `select`. */
	ctx?: { ui?: Partial<FermentUi> }
	/** Optional. When provided, `askUser` calls `runtime.markHumanInput()`
	 *  on user-answered responses so downstream signals (nudge throttling,
	 *  planner-supplement freshness) reflect the interaction. */
	runtime?: Pick<FermentRuntime, "markHumanInput">
}

/** True when the current PI session is the one-shot planner — no human is
 *  attached, so any question must route to the judge. */
function isOneShotSession(pi: ExtensionAPI): boolean {
	return pi.getFlag?.("ferment-oneshot") === true
}

const ASK_USER_SYSTEM = `You are standing in for the user during an autonomous ferment run. A planner agent has reached a decision point it cannot resolve from context alone and is asking the user. There is no human available — you decide.

Your bias:
- Choose the option that best serves the ferment's stated goal and success criteria, NOT whatever moves work forward fastest.
- When two options seem equivalent, prefer the more conservative one (less destructive, more revertible).
- When you genuinely cannot tell which option is best, choose the option that explicitly preserves optionality (pause / revise / abandon).

You will be given:
- The ferment goal and success criteria.
- The current phase and step (when applicable).
- The question the agent is asking.
- The set of options, each with an id and a label (sometimes a description).

Return EXACTLY one JSON object, no markdown, no prose:
For single-choice questions return:
{"choice":"<option_id>","rationale":"<one sentence justifying the choice>"}

The "choice" MUST be one of the provided option ids verbatim. If you cannot in good faith pick any option, choose the option whose id contains "pause", "abandon", or "cancel" — falling back to the FIRST option only as a last resort.

For multi-select questions return:
{"choices":["<option_id>"],"rationale":"<one sentence justifying the choices>"}

Every item in "choices" MUST be one of the provided option ids verbatim. Choose one or more.

For text questions return:
{"text":"<answer>","rationale":"<one sentence justifying the answer>"}

The text answer should be concise and directly usable by the planner.`

const ASK_USER_FORM_SYSTEM = `You are standing in for the user during an autonomous ferment run. A planner agent has reached decision points it cannot resolve from context alone and is asking a structured form. There is no human available — you decide.

Your bias:
- Choose answers that best serve the ferment's stated goal and success criteria, NOT whatever moves work forward fastest.
- When two answers seem equivalent, prefer the more conservative one (less destructive, more revertible).
- When you genuinely cannot tell, choose or write the answer that preserves optionality.

Return EXACTLY one JSON object, no markdown, no prose:
{"answers":[{"id":"<question_id>","value":"<answer>"}],"rationale":"<one sentence justifying the answers>"}

For radio questions, "value" MUST be one provided option id unless allowOther is true.
For checkbox questions, "value" MUST be an array of one or more provided option ids unless allowOther is true.
For text questions, "value" MUST be a concise directly usable string.
Optional questions may be omitted. Required questions must be answered.`

function buildAskJudgeUserMsg(
	question: string,
	options: ReadonlyArray<AskUserOption>,
	ferment: Ferment,
	responseType: AskUserResponseType,
): string {
	const activePhase = ferment.phases.find((p) => p.status === "active")
	const activeStep = activePhase?.steps.find((s) => s.status === "running")
	const optionLines = options
		.map((o) => `  - id="${o.id}"  label="${o.label}"${o.description ? `  description="${o.description}"` : ""}`)
		.join("\n")
	const parts: string[] = []
	parts.push(`Ferment: "${ferment.name}"`)
	parts.push(`Goal: ${ferment.goal ?? "(none specified)"}`)
	parts.push(`Success criteria: ${ferment.successCriteria ?? "(none specified)"}`)
	if (activePhase) parts.push(`Active phase: ${activePhase.index}. "${activePhase.name}" — ${activePhase.goal}`)
	if (activeStep) parts.push(`Active step: ${activeStep.index}. "${activeStep.description}"`)
	parts.push("")
	parts.push(`Requested response type: ${responseType}`)
	parts.push(`Question: ${question}`)
	if (options.length > 0) {
		parts.push("")
		parts.push("Options:")
		parts.push(optionLines)
	}
	return parts.join("\n")
}

function buildAskJudgeFormUserMsg(
	title: string | undefined,
	description: string | undefined,
	questions: ReadonlyArray<AskUserQuestion>,
	ferment: Ferment,
): string {
	const activePhase = ferment.phases.find((p) => p.status === "active")
	const activeStep = activePhase?.steps.find((s) => s.status === "running")
	const parts: string[] = []
	parts.push(`Ferment: "${ferment.name}"`)
	parts.push(`Goal: ${ferment.goal ?? "(none specified)"}`)
	parts.push(`Success criteria: ${ferment.successCriteria ?? "(none specified)"}`)
	if (activePhase) parts.push(`Active phase: ${activePhase.index}. "${activePhase.name}" — ${activePhase.goal}`)
	if (activeStep) parts.push(`Active step: ${activeStep.index}. "${activeStep.description}"`)
	parts.push("")
	if (title) parts.push(`Form title: ${title}`)
	if (description) parts.push(`Form context: ${description}`)
	parts.push("Questions:")
	for (const q of questions) {
		parts.push(
			`  - id="${q.id}" type="${q.type}" required="${q.required !== false}" allowOther="${q.allowOther === true}" prompt="${q.prompt}"`,
		)
		if (q.options && q.options.length > 0) {
			for (const o of q.options) {
				parts.push(
					`      option id="${o.id}" label="${o.label}"${o.description ? ` description="${o.description}"` : ""}`,
				)
			}
		}
	}
	return parts.join("\n")
}

function parseJudgeJson(text: string): unknown {
	let s = text.trim()
	if (s.startsWith("```")) {
		s = s
			.replace(/^```[a-z]*\n?/i, "")
			.replace(/```$/, "")
			.trim()
	}
	try {
		return JSON.parse(s)
	} catch {
		const m = s.match(/\{[\s\S]*\}/)
		if (!m) return undefined
		try {
			return JSON.parse(m[0])
		} catch {
			return undefined
		}
	}
}

function parseJudgeAnswer(
	text: string,
	options: ReadonlyArray<AskUserOption>,
	responseType: AskUserResponseType,
): Omit<AskUserSuccess, "answered_by" | "response_type"> | undefined {
	const parsed = parseJudgeJson(text)
	if (!parsed || typeof parsed !== "object") return undefined
	const obj = parsed as { choice?: unknown; choices?: unknown; text?: unknown; rationale?: unknown }
	const rationale = typeof obj.rationale === "string" ? obj.rationale : "(no rationale provided)"

	if (responseType === "text") {
		if (typeof obj.text !== "string" || obj.text.trim() === "") return undefined
		return { text: obj.text.trim().slice(0, 4000), rationale: rationale.slice(0, 400) }
	}

	if (responseType === "multi") {
		if (!Array.isArray(obj.choices)) return undefined
		const choices = obj.choices.filter((choice): choice is string => typeof choice === "string")
		if (choices.length === 0) return undefined
		if (choices.some((choice) => !options.some((o) => o.id === choice))) return undefined
		return { choices: Array.from(new Set(choices)), rationale: rationale.slice(0, 400) }
	}

	if (typeof obj.choice !== "string") return undefined
	if (!options.some((o) => o.id === obj.choice)) return undefined
	return { choice: obj.choice, rationale: rationale.slice(0, 400) }
}

function validateFormQuestions(questions: ReadonlyArray<AskUserQuestion>): string | undefined {
	if (questions.length === 0) return "askUserForm called with no questions."
	const seen = new Set<string>()
	for (const q of questions) {
		if (!q.id.trim()) return "askUserForm question id must be non-empty."
		if (seen.has(q.id)) return `askUserForm question id "${q.id}" is duplicated.`
		seen.add(q.id)
		if (!q.prompt.trim()) return `askUserForm question "${q.id}" prompt must be non-empty.`
		if ((q.type === "radio" || q.type === "checkbox") && (q.options?.length ?? 0) === 0 && !q.allowOther) {
			return `askUserForm question "${q.id}" is type "${q.type}" but has no options and allowOther is false.`
		}
	}
	return undefined
}

function answerFromValue(q: AskUserQuestion, rawValue: unknown): AskUserAnswer | undefined {
	const type = q.type
	if (type === "text") {
		if (typeof rawValue !== "string") return undefined
		const text = rawValue.trim().slice(0, 4000)
		if (!text) return undefined
		return { id: q.id, type, value: text, label: text, wasCustom: true }
	}

	if (type === "radio") {
		if (typeof rawValue !== "string") return undefined
		const value = rawValue.trim()
		if (!value) return undefined
		const option = q.options?.find((o) => o.id === value)
		if (option) return { id: q.id, type, value: option.id, label: option.label, wasCustom: false }
		if (q.allowOther)
			return { id: q.id, type, value: value.slice(0, 1000), label: value.slice(0, 1000), wasCustom: true }
		return undefined
	}

	const rawValues = Array.isArray(rawValue)
		? rawValue
		: typeof rawValue === "string"
			? rawValue
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean)
			: []
	const values: string[] = []
	const labels: string[] = []
	let wasCustom = false
	for (const raw of rawValues) {
		if (typeof raw !== "string") return undefined
		const value = raw.trim()
		if (!value || values.includes(value)) continue
		const option = q.options?.find((o) => o.id === value)
		if (option) {
			values.push(option.id)
			labels.push(option.label)
		} else if (q.allowOther) {
			const custom = value.slice(0, 1000)
			values.push(custom)
			labels.push(custom)
			wasCustom = true
		} else {
			return undefined
		}
	}
	if (values.length === 0) return undefined
	return {
		id: q.id,
		type,
		value: values.join(", "),
		label: labels.join(", "),
		wasCustom,
		values,
		labels,
	}
}

function parseJudgeFormAnswer(
	text: string,
	questions: ReadonlyArray<AskUserQuestion>,
): Pick<AskUserSuccess, "answers" | "rationale"> | undefined {
	const parsed = parseJudgeJson(text)
	if (!parsed || typeof parsed !== "object") return undefined
	const obj = parsed as { answers?: unknown; rationale?: unknown }
	if (!Array.isArray(obj.answers)) return undefined
	const rationale = typeof obj.rationale === "string" ? obj.rationale : "(no rationale provided)"
	const byId = new Map<string, unknown>()
	for (const rawAnswer of obj.answers) {
		if (!rawAnswer || typeof rawAnswer !== "object") return undefined
		const answer = rawAnswer as { id?: unknown; value?: unknown }
		if (typeof answer.id !== "string") return undefined
		byId.set(answer.id, answer.value)
	}

	const answers: AskUserAnswer[] = []
	for (const q of questions) {
		if (!byId.has(q.id)) {
			if (q.required !== false) return undefined
			continue
		}
		const answer = answerFromValue(q, byId.get(q.id))
		if (!answer) {
			if (q.required === false) continue
			return undefined
		}
		answers.push(answer)
	}
	return { answers, rationale: rationale.slice(0, 400) }
}

function mapPromptFormAnswers(
	questions: ReadonlyArray<AskUserQuestion>,
	answers: ReadonlyArray<import("./prompt-ui.js").PromptFormAnswer>,
): AskUserAnswer[] {
	return answers.map((answer) => {
		const question = questions.find((q) => q.id === answer.id)
		const type = question?.type ?? (answer.values ? "checkbox" : answer.wasCustom ? "text" : "radio")
		return {
			id: answer.id,
			type,
			value: answer.values ? answer.values.join(", ") : answer.value,
			label: answer.labels ? answer.labels.join(", ") : answer.label,
			wasCustom: answer.wasCustom,
			values: answer.values,
			labels: answer.labels,
		}
	})
}

/** Ask the judge as a stand-in user. Returns a structured success or a typed
 *  failure. Callers decide whether failure is fatal (one-shot mode) or
 *  recoverable (interactive degrade). */
export async function askJudge(
	question: string,
	options: ReadonlyArray<AskUserOption>,
	ferment: Ferment,
	responseTypeOrApiCall:
		| AskUserResponseType
		| ((sys: string, msg: string, maxTokens?: number) => Promise<JudgeApiResult>) = "single",
	apiCallOverride?: (sys: string, msg: string, maxTokens?: number) => Promise<JudgeApiResult>,
): Promise<AskUserResponse> {
	const responseType = typeof responseTypeOrApiCall === "string" ? responseTypeOrApiCall : "single"
	const apiCall =
		typeof responseTypeOrApiCall === "function" ? responseTypeOrApiCall : (apiCallOverride ?? judgeApiCall)
	const userMsg = buildAskJudgeUserMsg(question, options, ferment, responseType)
	const result = await apiCall(ASK_USER_SYSTEM, userMsg, 200)
	if (!result.ok) {
		return {
			failed: true,
			reason: "judge_unavailable",
			detail: `Judge unreachable (${result.reason}${result.detail ? `: ${result.detail}` : ""}).`,
		}
	}
	const parsed = parseJudgeAnswer(result.text, options, responseType)
	if (!parsed) {
		return {
			failed: true,
			reason: "judge_unparseable",
			detail: `Judge returned unparseable output: ${result.text.slice(0, 200)}`,
		}
	}
	return { ...parsed, response_type: responseType, answered_by: "judge" }
}

export async function askJudgeForm(
	title: string | undefined,
	description: string | undefined,
	questions: ReadonlyArray<AskUserQuestion>,
	ferment: Ferment,
	apiCall: (sys: string, msg: string, maxTokens?: number) => Promise<JudgeApiResult> = judgeApiCall,
): Promise<AskUserResponse> {
	const validationError = validateFormQuestions(questions)
	if (validationError) {
		return { failed: true, reason: "invalid_choice", detail: validationError }
	}
	const userMsg = buildAskJudgeFormUserMsg(title, description, questions, ferment)
	const result = await apiCall(ASK_USER_FORM_SYSTEM, userMsg, 500)
	if (!result.ok) {
		return {
			failed: true,
			reason: "judge_unavailable",
			detail: `Judge unreachable (${result.reason}${result.detail ? `: ${result.detail}` : ""}).`,
		}
	}
	const parsed = parseJudgeFormAnswer(result.text, questions)
	if (!parsed) {
		return {
			failed: true,
			reason: "judge_unparseable",
			detail: `Judge returned unparseable output: ${result.text.slice(0, 200)}`,
		}
	}
	return { ...parsed, response_type: "form", answered_by: "judge" }
}

export async function askUserForm(
	title: string | undefined,
	description: string | undefined,
	questions: ReadonlyArray<AskUserQuestion>,
	context: AskUserContext,
	overrides?: AskUserOverrides,
): Promise<AskUserResponse> {
	const validationError = validateFormQuestions(questions)
	if (validationError) {
		return { failed: true, reason: "invalid_choice", detail: validationError }
	}

	const oneShot = isOneShotSession(context.pi)
	if (oneShot) {
		const judge = overrides?.askJudgeForm ?? askJudgeForm
		return judge(title, description, questions, context.ferment)
	}

	const ui = context.ctx?.ui
	if (ui) {
		const result = await promptForm(context.ctx, { title, description, questions })
		if (!result || result.cancelled) {
			return { failed: true, reason: "user_cancelled", detail: "User cancelled the prompt." }
		}
		context.runtime?.markHumanInput()
		return {
			response_type: "form",
			answers: mapPromptFormAnswers(questions, result.answers),
			answered_by: "user",
		}
	}

	return {
		failed: true,
		reason: "no_ui_no_judge",
		detail: "No TUI attached and not in one-shot mode — cannot route the questions to any audience.",
	}
}

/** Routing entry point. Picks the right audience for the question, returns
 *  a uniform response shape. Read the file header for the routing rules. */
export async function askUser(
	question: string,
	options: ReadonlyArray<AskUserOption>,
	context: AskUserContext,
	responseTypeOrOverrides: AskUserResponseType | AskUserOverrides = "single",
	overrides?: AskUserOverrides,
): Promise<AskUserResponse> {
	const responseType = typeof responseTypeOrOverrides === "string" ? responseTypeOrOverrides : "single"
	const effectiveOverrides = typeof responseTypeOrOverrides === "string" ? overrides : responseTypeOrOverrides
	if (responseType !== "text" && options.length === 0) {
		return {
			failed: true,
			reason: "invalid_choice",
			detail: `askUser called with empty options array for ${responseType} question.`,
		}
	}

	const oneShot = isOneShotSession(context.pi)

	if (oneShot) {
		// One-shot: judge is the only legitimate audience. No fallback to TUI
		// even if a UI happens to be attached — the contract says one-shot
		// runs are unattended, and we don't want to half-prompt a CLI user.
		const judge = effectiveOverrides?.askJudge ?? askJudge
		return judge(question, options, context.ferment, responseType)
	}

	// Interactive: route to TUI when available.
	const ui = context.ctx?.ui
	if (ui) {
		const result = await promptForm(context.ctx, {
			questions: [
				{
					id: "answer",
					type: responseType === "multi" ? "checkbox" : responseType === "text" ? "text" : "radio",
					prompt: question,
					options,
					allowOther: false,
				},
			],
		})
		if (!result || result.cancelled || result.answers.length === 0) {
			if (result && !result.cancelled && result.answers.length === 0) {
				return { failed: true, reason: "invalid_choice", detail: "UI returned no valid answer." }
			}
			return { failed: true, reason: "user_cancelled", detail: "User cancelled the prompt." }
		}
		const answer = result.answers[0]
		if (!answer) {
			return { failed: true, reason: "user_cancelled", detail: "User cancelled the prompt." }
		}
		if (responseType === "text") {
			context.runtime?.markHumanInput()
			return { text: answer.value, response_type: "text", answered_by: "user" }
		}
		if (responseType === "multi") {
			const choices = answer.values ?? answer.value.split(",").map((value) => value.trim())
			if (choices.length === 0 || choices.some((choice) => !options.some((o) => o.id === choice))) {
				return {
					failed: true,
					reason: "invalid_choice",
					detail: `UI returned a value not in the options set: ${choices.join(", ")}`,
				}
			}
			context.runtime?.markHumanInput()
			return { choices, response_type: "multi", answered_by: "user" }
		}
		if (!options.some((o) => o.id === answer.value)) {
			return {
				failed: true,
				reason: "invalid_choice",
				detail: `UI returned a value not in the options set: ${answer.value}`,
			}
		}
		// Side effect: mark human input so downstream signals (nudge throttling,
		// planner-supplement freshness) reflect that the user just interacted.
		// Skipped for judge-answered responses since no human was involved.
		context.runtime?.markHumanInput()
		return { choice: answer.value, response_type: "single", answered_by: "user" }
	}

	return {
		failed: true,
		reason: "no_ui_no_judge",
		detail: "No TUI attached and not in one-shot mode — cannot route the question to any audience.",
	}
}
