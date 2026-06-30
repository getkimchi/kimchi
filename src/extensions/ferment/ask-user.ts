/**
 * Ask-user primitive — the single decision-point routing layer.
 *
 * Replaces ad-hoc `ctx.ui?.select(...)` calls scattered across tool handlers
 * with one function that handles three audiences:
 *
 *   1. Interactive sessions (plan / exec / auto with a TUI attached) — routes
 *      to a richer TUI prompt. The user picks or writes; we return structured
 *      data.
 *   2. One-shot sessions (no human at the keyboard) — routes to the configured
 *      judge model that stands in for the user. The judge sees the ferment goal
 *      + success criteria + current phase/step + question + options, picks one
 *      with a rationale.
 *   3. Headless with no judge available — returns `{ failed: true }` and the
 *      caller is responsible for handling (typically by abandoning the
 *      ferment in one-shot mode).
 *
 * The agent-callable `ask_user` tool wraps this with a tool-error layer that
 * abandons the ferment when the judge can't be reached in one-shot mode.
 * Internal callers (interactive dropdowns, escalation, propose_ferment_scoping) check
 * the `failed` flag and degrade gracefully.
 *
 * Detection of one-shot mode comes from the `ferment-oneshot` PI flag (set at
 * session boot by /ferment one-shot or --ferment-oneshot). The flag is
 * session-level, whereas a Ferment can outlive the session that created it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { renderLabeledSuccessCriteria } from "../../ferment/success-criteria.js"
import type { Ferment, ScopingQuestionType } from "../../ferment/types.js"
import { YES_NO_OPTIONS, normalizeQuestionType } from "../questionnaire/index.js"
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
export type AskUserResponseType = "single" | "multi" | "text" | "confirm"
export type AskUserQuestionType = ScopingQuestionType

export interface AskUserQuestion {
	id: string
	type: AskUserQuestionType
	prompt: string
	label?: string
	options?: AskUserOption[]
	allowOther?: boolean
	required?: boolean
}

export interface AskUserAnswer {
	id: string
	type: AskUserQuestionType
	/** Single value for single/confirm/text, or comma-joined values for multi. */
	value: string
	/** Display label for single/confirm/text, or comma-joined labels for multi. */
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

export interface AskUserContext {
	ferment: Ferment
	pi: ExtensionAPI
	/** TUI hook. Accepts `Partial<FermentUi>` (matches `StepUiContext` /
	 *  `PhaseUiContext`) — the only method we actually read is `select`. */
	ctx?: { ui?: Partial<FermentUi> }
	/** Optional. When provided, `askUser` calls `runtime.markHumanInput()`
	 *  on user-answered responses so downstream signals (nudge throttling,
	 *  prompt-block freshness) reflect the interaction. */
	runtime?: Pick<FermentRuntime, "markHumanInput">
}

/** True when the current PI session is the one-shot planner — no human is
 *  attached, so any question must route to the judge. */
function isOneShotSession(pi: ExtensionAPI): boolean {
	return pi.getFlag?.("ferment-oneshot") === true
}

export interface NormalizedScopingType {
	/** Canonical question vocabulary shared across Ferment and questionnaire. */
	type: AskUserQuestionType
	/** True when the agent asked for a yes/no confirm. */
	isConfirm: boolean
}

/** Normalize one question type to the canonical single/multi/text/confirm
 *  vocabulary. There are no radio/checkbox aliases. Delegates to
 *  `normalizeQuestionType`, so an omitted type defaults to single and any
 *  unknown string throws rather than silently becoming single. Shared by the
 *  `ask_user` tool and `propose_ferment_scoping` so every question surface uses
 *  one contract. */
export function toScopingQuestionType(rawType: string | undefined): NormalizedScopingType {
	// The generic questionnaire type and Ferment scoping type are intentionally
	// declared in separate layers; this helper is the narrow bridge between them.
	const canonical = normalizeQuestionType(rawType) as AskUserQuestionType
	return { type: canonical, isConfirm: canonical === "confirm" }
}

/** A question as it arrives from the tool schema, before type normalization.
 *  The agent-facing `type` is single/multi/text/confirm — one vocabulary, no
 *  aliases — so ask_user and the questionnaire tool present one identical
 *  contract (the fix for LLM-1928). */
export interface RawAskUserQuestion extends Omit<AskUserQuestion, "type"> {
	type?: string
}

export type NormalizeAskUserResult = { ok: true; questions: AskUserQuestion[] } | { ok: false; error: string }

/** Normalize the agent-facing question type. `confirm` is always Yes/No and
 *  must not carry options or `allowOther`; supplying either is rejected rather
 *  than silently rewritten, so a bad tool call surfaces. An unknown `type` is
 *  reported as a tool error rather than thrown, matching the
 *  `propose_ferment_scoping` path. */
export function normalizeAskUserQuestions(questions: ReadonlyArray<RawAskUserQuestion>): NormalizeAskUserResult {
	const normalized: AskUserQuestion[] = []
	const seen = new Set<string>()
	for (const q of questions) {
		if (!q.id || !q.id.trim()) {
			return {
				ok: false,
				error: 'Question is missing required field "id" — a stable identifier returned with the answer.',
			}
		}
		if (seen.has(q.id)) {
			return {
				ok: false,
				error: `Question id "${q.id}" is duplicated — each question needs a unique id.`,
			}
		}
		seen.add(q.id)
		if (!q.prompt || !q.prompt.trim()) {
			return {
				ok: false,
				error: `Question "${q.id}" is missing required field "prompt" — the question text shown to the user.`,
			}
		}
		let normalizedType: NormalizedScopingType
		try {
			normalizedType = toScopingQuestionType(q.type)
		} catch (error) {
			return {
				ok: false,
				error: `Question "${q.id}" has unknown type "${q.type}" — must be one of: single, multi, text, confirm.`,
			}
		}
		const { type, isConfirm } = normalizedType
		if (isConfirm) {
			if ((q.options?.length ?? 0) > 0) {
				return {
					ok: false,
					error: `Question "${q.id}" is type "confirm" and must not have options — confirm is always Yes/No.`,
				}
			}
			if (q.allowOther) {
				return {
					ok: false,
					error: `Question "${q.id}" is type "confirm" and must not set allowOther — confirm is always Yes/No.`,
				}
			}
			normalized.push({ ...q, type, options: [...YES_NO_OPTIONS] })
			continue
		}
		if ((type === "single" || type === "multi") && (q.options?.length ?? 0) === 0 && !q.allowOther) {
			return {
				ok: false,
				error: `Question "${q.id}" is type "${type}" but has no options and allowOther is false — provide options or set allowOther: true.`,
			}
		}
		normalized.push({ ...q, type })
	}
	return { ok: true, questions: normalized }
}

const ASK_USER_FORM_MAX_ATTEMPTS = 3

const ASK_USER_FORM_SYSTEM = `You are standing in for the user during an autonomous ferment run. A planner agent has reached decision points it cannot resolve from context alone and is asking a structured form. There is no human available — you decide.

Your bias:
- Choose answers that best serve the ferment's stated goal and success criteria, NOT whatever moves work forward fastest.
- When two answers seem equivalent, prefer the more conservative one (less destructive, more revertible).
- When you genuinely cannot tell, choose or write the answer that preserves optionality.

Return EXACTLY one JSON object, no markdown, no prose:
{"answers":[{"id":"<question_id>","value":"<answer>"}],"rationale":"<one sentence justifying the answers>"}

For single questions, "value" MUST be one provided option id unless allowOther is true.
For confirm questions, "value" MUST be "yes" or "no".
For multi questions, "value" MUST be an array of one or more provided option ids unless allowOther is true.
For text questions, "value" MUST be a concise directly usable string.
Optional questions may be omitted. Required questions must be answered.

Example:
Questions: [{"id":"approach","type":"single","prompt":"Which approach?","options":[{"id":"safe","label":"Safe path"},{"id":"fast","label":"Fast path"}]},{"id":"note","type":"text","prompt":"Any notes?"}]
Correct response: {"answers":[{"id":"approach","value":"safe"},{"id":"note","value":"Keep it reversible."}],"rationale":"Safe path is more reversible."}`

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
	parts.push(renderLabeledSuccessCriteria("Success criteria", ferment.successCriteria))
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
		if ((q.type === "single" || q.type === "multi") && q.allowOther) {
			parts.push(`      custom label="Type your own answer" value="<free-form text>"`)
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

function validateFormQuestions(questions: ReadonlyArray<AskUserQuestion>): string | undefined {
	if (questions.length === 0) return "askUserForm called with no questions."
	const seen = new Set<string>()
	for (const q of questions) {
		if (!q.id.trim()) return "askUserForm question id must be non-empty."
		if (seen.has(q.id)) return `askUserForm question id "${q.id}" is duplicated.`
		seen.add(q.id)
		if (!q.prompt.trim()) return `askUserForm question "${q.id}" prompt must be non-empty.`
		if ((q.type === "single" || q.type === "multi") && (q.options?.length ?? 0) === 0 && !q.allowOther) {
			return `askUserForm question "${q.id}" is type "${q.type}" but has no options and allowOther is false.`
		}
		if (q.type === "confirm") {
			const ids = (q.options ?? []).map((o) => o.id)
			if (ids.length !== 2 || !ids.includes("yes") || !ids.includes("no")) {
				return `askUserForm question "${q.id}" is type "confirm" but does not have fixed Yes/No options.`
			}
			if (q.allowOther) {
				return `askUserForm question "${q.id}" is type "confirm" and must not set allowOther.`
			}
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

	if (type === "single" || type === "confirm") {
		if (typeof rawValue !== "string") return undefined
		const value = rawValue.trim()
		if (!value) return undefined
		const option = q.options?.find((o) => o.id === value)
		if (option) return { id: q.id, type, value: option.id, label: option.label, wasCustom: false }
		if (q.allowOther)
			return { id: q.id, type, value: value.slice(0, 1000), label: value.slice(0, 1000), wasCustom: true }
		return undefined
	}

	if (type !== "multi") return undefined

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

/** Choose a reasonable default answer for a question when the judge is
 *  completely unavailable. The defaults allow the ferment to proceed —
 *  confirm → "yes", single → first listed option (presumed highest priority),
 *  multi → first listed option, text → a placeholder so the form can still be
 *  consumed. */
function defaultAnswerForQuestion(q: AskUserQuestion): AskUserAnswer {
	if (q.type === "confirm") {
		// Default to "yes" — let the ferment proceed rather than stall.
		const yesOption = q.options?.find((o) => o.id === "yes")
		return { id: q.id, type: "confirm", value: "yes", label: yesOption?.label ?? "Yes", wasCustom: false }
	}
	if (q.type === "single" && q.options && q.options.length > 0) {
		// Default to the first option (the agent presumably listed them in priority order).
		const first = q.options[0]
		return { id: q.id, type: "single", value: first.id, label: first.label, wasCustom: false }
	}
	if (q.type === "multi" && q.options && q.options.length > 0) {
		// Default to the first option only.
		const first = q.options[0]
		return {
			id: q.id,
			type: "multi",
			value: first.id,
			label: first.label,
			wasCustom: false,
			values: [first.id],
			labels: [first.label],
		}
	}
	// For text questions (or malformed single/multi with no options), default
	// to an empty-but-valid answer.
	return {
		id: q.id,
		type: "text",
		value: "(no answer — judge was unavailable)",
		label: "(no answer)",
		wasCustom: true,
	}
}

function parseJudgeFormAnswer(
	text: string,
	questions: ReadonlyArray<AskUserQuestion>,
): Pick<AskUserSuccess, "answers" | "rationale"> | undefined {
	const parsed = parseJudgeJson(text)
	if (!parsed || typeof parsed !== "object") return undefined
	const obj = parsed as { answers?: unknown; rationale?: unknown; [key: string]: unknown }
	const rationale = typeof obj.rationale === "string" ? obj.rationale : "(no rationale provided)"

	let rawAnswers: unknown[]
	if (Array.isArray(obj.answers)) {
		rawAnswers = obj.answers
	} else {
		// Alternative format: question-id keys directly on the top-level object,
		// e.g. {"approach":"safe","note":"Keep it simple."}. Accept it when at
		// least one key matches a known question id.
		const questionIds = new Set(questions.map((q) => q.id))
		const matchedKeys = Object.keys(obj).filter((k) => k !== "rationale" && questionIds.has(k))
		if (matchedKeys.length === 0) return undefined
		rawAnswers = matchedKeys.map((id) => ({ id, value: obj[id] }))
	}

	const byId = new Map<string, unknown>()
	for (const rawAnswer of rawAnswers) {
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
		const type = question?.type ?? (answer.values ? "multi" : answer.wasCustom ? "text" : "single")
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
	const maxTokens = Math.min(2000, Math.max(500, questions.length * 200 + 200))

	for (let attempt = 1; attempt <= ASK_USER_FORM_MAX_ATTEMPTS; attempt++) {
		const systemPrompt =
			attempt > 1
				? `${ASK_USER_FORM_SYSTEM}\n\nWARNING: Your previous response was not valid or did not match the expected schema. Return ONLY a JSON object: {"answers":[{"id":"<question_id>","value":"<answer>"}],"rationale":"..."}. No markdown, no prose.`
				: ASK_USER_FORM_SYSTEM
		let result: JudgeApiResult
		try {
			result = await apiCall(systemPrompt, userMsg, maxTokens)
		} catch {
			continue
		}
		if (!result.ok) {
			continue
		}
		const parsed = parseJudgeFormAnswer(result.text, questions)
		if (!parsed) {
			continue
		}
		return { ...parsed, response_type: "form", answered_by: "judge" }
	}

	// Fallback: if the judge completely fails after all retries, choose reasonable
	// defaults rather than abandoning the ferment. This prevents transient judge
	// failures from killing a ferment run.
	const fallbackAnswers = questions.map((q) => defaultAnswerForQuestion(q))
	return {
		response_type: "form",
		answers: fallbackAnswers,
		answered_by: "judge",
		rationale: `Judge was unavailable after ${ASK_USER_FORM_MAX_ATTEMPTS} attempts; using conservative defaults.`,
	}
}

export async function askUserForm(
	title: string | undefined,
	description: string | undefined,
	questions: ReadonlyArray<AskUserQuestion>,
	context: AskUserContext,
): Promise<AskUserResponse> {
	const validationError = validateFormQuestions(questions)
	if (validationError) {
		return { failed: true, reason: "invalid_choice", detail: validationError }
	}

	const oneShot = isOneShotSession(context.pi)
	if (oneShot) {
		return askJudgeForm(title, description, questions, context.ferment)
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
