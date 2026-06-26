/**
 * Ferment lifecycle tools: list, scope, update fields, complete.
 *
 * Tool handlers follow the pattern:
 *   1. Validate UI-flow gates (scoping confirmation, etc.) — host concern
 *   2. Build a Command and call applyAndPersist — state machine concern
 *   3. Run side effects (judge calls, nudges) — host concern
 *   4. Format result text — host concern
 */

import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent"
import { Markdown } from "@earendil-works/pi-tui"
import { type Static, Type } from "typebox"
import type { Command, ScopePhaseInput } from "../../../ferment/state-machine.js"
import {
	type SuccessCriteria,
	normalizeSuccessCriteriaInput,
	renderSuccessCriteria,
} from "../../../ferment/success-criteria.js"
import { deriveDraftFermentTitle, normalizeFermentTitle } from "../../../ferment/title.js"
import {
	DEFAULT_SCOPING_QUESTION_TYPE,
	type Grade,
	SCOPING_QUESTION_TYPES,
	type ScopingQuestion,
	type ScopingQuestionType,
} from "../../../ferment/types.js"
import { createToolVisibility } from "../../prompt-construction/tool-visibility.js"
import { YES_NO_OPTIONS } from "../../questionnaire/index.js"
import {
	type AskUserQuestion,
	askUser,
	askUserForm,
	normalizeAskUserQuestions,
	toScopingQuestionType,
} from "../ask-user.js"
import { pr_bold, pr_dim } from "../colors.js"
import { emitFermentCreated } from "../domain-events-emitter.js"
import { validateFsmTransitionWithFerment } from "../fsm-adapter.js"
import { renderGateGuidance } from "../gate-registry.js"
import { assertGateFieldsPresent, validateGatesOrErr } from "../gate-validation.js"
import { ensureGitRepo } from "../git-init.js"
import { judgeJourneyGrade } from "../judge.js"
import { appendRefEntry, resetReactiveContinuationNudgeCount } from "../nudge.js"
import { gatherPhaseEvidence } from "../phase-evidence.js"
import { getPromptUi, promptEditor, promptForm, promptSelect } from "../prompt-ui.js"
import { readLatestPhaseReviews } from "../review-evidence.js"
import { type FermentRuntime, defaultFermentRuntime } from "../runtime.js"
import { confirmPendingScope } from "../scoping-confirmation.js"
import type { PendingScope } from "../scoping.js"
import {
	createApplyAndPersist,
	failedToolResult,
	toolErr,
	toolErrWithNextAction,
	toolOk,
	withNextActionHint,
} from "../tool-helpers.js"
import { FERMENT_TOOLS } from "../tool-names.js"
import {
	AskUserParams,
	CompleteFermentParams,
	ConfirmCompletionCriteriaParams,
	ListParams,
	ProposeScopingParams,
	ScopeParams,
	UpdateScopeFieldParams,
} from "../tool-schemas.js"
import { setActiveFermentAndApplyProfile } from "../tool-scope.js"
import type { FermentUi } from "../ui.js"

type ScopeArgs = Static<typeof ScopeParams>
type ProposeScopingArgs = Static<typeof ProposeScopingParams>
type NormalizedProposeScopingArgs = Omit<
	ProposeScopingArgs,
	"constraints" | "phases" | "questions" | "assumptions" | "success_criteria"
> & {
	constraints?: string[]
	assumptions?: string
	success_criteria?: SuccessCriteria
	phases: ScopePhaseInput[]
	questions?: ScopingQuestion[]
}
type NormalizeProposeScopingResult =
	| { ok: true; params: NormalizedProposeScopingArgs }
	| { ok: false; error: ReturnType<typeof toolErr> }
type CompleteFermentArgs = Static<typeof CompleteFermentParams>
type ConfirmCompletionCriteriaArgs = Static<typeof ConfirmCompletionCriteriaParams>
type ToolResult = ReturnType<typeof toolOk> | ReturnType<typeof toolErr>
type ScopingAnswer = {
	questionId: string
	optionId: string
	label: string
	recommended: boolean
}

const SCOPING_STATUS_KEY = "ferment-scoping"
const TITLE_REQUIRED_ERROR =
	'Field "title" must be a non-empty concise 3-5 word title. Retry with the full payload including title.'

export interface LifecycleExecutionContext {
	pi: ExtensionAPI
}

function clearScopingStatus(ctx: unknown): void {
	;(ctx as { ui?: { setStatus?: (key: string, message: string | undefined) => void } } | undefined)?.ui?.setStatus?.(
		SCOPING_STATUS_KEY,
		undefined,
	)
}

const validateFsmTransition = (
	f: Parameters<typeof validateFsmTransitionWithFerment>[0],
	event: Parameters<typeof validateFsmTransitionWithFerment>[1],
	params?: Parameters<typeof validateFsmTransitionWithFerment>[2],
): string | null => validateFsmTransitionWithFerment(f, event, params).error ?? null

function parseJsonArray(value: unknown, field: string): unknown[] | string {
	if (Array.isArray(value)) return value
	if (typeof value !== "string") return `Field "${field}" must be an array.`
	const trimmed = value.trim()
	const unfenced = trimmed
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim()
	const start = unfenced.indexOf("[")
	const end = unfenced.lastIndexOf("]")
	const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced
	try {
		const parsed = JSON.parse(candidate)
		if (!Array.isArray(parsed)) return `Field "${field}" was a JSON string, but it did not decode to an array.`
		return parsed
	} catch {
		return `Field "${field}" was a string, but it did not contain a valid JSON array. Emit ${field} as a real array, not prose or malformed JSON text.`
	}
}

function normalizeStringArray(value: unknown, field: string): string[] | undefined | string {
	if (value === undefined) return undefined
	if (typeof value === "string") {
		const trimmed = value.trim()
		if (trimmed === "") return []
		if (!trimmed.startsWith("[")) {
			return trimmed
				.split(/\r?\n|;/)
				.map((item) => item.trim())
				.filter(Boolean)
		}
	}
	const parsed = parseJsonArray(value, field)
	if (typeof parsed === "string") return parsed
	if (parsed.some((item) => typeof item !== "string")) return `Field "${field}" must contain only strings.`
	return parsed as string[]
}

function splitListText(value: string | undefined): string[] {
	if (!value) return []
	return value
		.split(/\r?\n|;/)
		.map((item) => item.replace(/^[-*]\s+/, "").trim())
		.filter(Boolean)
}

function wrapText(value: string, width = 92): string[] {
	const words = value.trim().split(/\s+/).filter(Boolean)
	if (words.length === 0) return []
	const lines: string[] = []
	let line = ""
	for (const word of words) {
		if (line && `${line} ${word}`.length > width) {
			lines.push(line)
			line = word
		} else {
			line = line ? `${line} ${word}` : word
		}
	}
	if (line) lines.push(line)
	return lines
}

function renderWrapped(label: string, value: string | undefined): string {
	const lines = wrapText(value || "—")
	const renderedLabel = label.startsWith("#") ? label : pr_bold(label)
	return [renderedLabel, ...lines.map((line) => `  ${line}`)].join("\n")
}

function renderBullets(label: string, items: string[]): string {
	if (items.length === 0) return renderWrapped(label, "—")
	const lines = items.flatMap((item) => {
		const cleaned = item.replace(/^[-*]\s+/, "").trim()
		return wrapText(cleaned, 88).map((line, index) => (index === 0 ? `  - ${line}` : `    ${line}`))
	})
	const renderedLabel = label.startsWith("#") ? label : pr_bold(label)
	return [renderedLabel, ...lines].join("\n")
}

function renderStep(index: number, description: string): string {
	const lines = wrapText(description, 84)
	if (lines.length === 0) return "- —"
	return lines.map((line, lineIndex) => (lineIndex === 0 ? `- ${line}` : `  ${line}`)).join("\n")
}

function concatenateAssumptionStrings(items: string[]): string | undefined {
	const fragments = items.map((item) => item.trim()).filter(Boolean)
	if (fragments.length === 0) return undefined
	return fragments.join("; ")
}

function normalizeAssumptions(value: unknown): string | undefined {
	if (value === undefined) return undefined
	if (Array.isArray(value)) {
		if (!value.every((item) => typeof item === "string")) return undefined
		return concatenateAssumptionStrings(value)
	}
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	if (!trimmed.startsWith("[")) return value
	try {
		const parsed = JSON.parse(trimmed)
		if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
			return concatenateAssumptionStrings(parsed)
		}
	} catch {
		// Leave the original text alone. `assumptions` is a string field, so a
		// malformed JSON-looking string is still better than rejecting the plan.
	}
	return value
}

function normalizePhases(value: ProposeScopingArgs["phases"]): ScopePhaseInput[] | string {
	const parsed = parseJsonArray(value, "phases")
	if (typeof parsed === "string") return parsed
	if (parsed.length < 1) return 'Field "phases" must contain at least 1 phase.'
	if (parsed.length > 7) return 'Field "phases" must contain at most 7 phases.'
	const phases: ScopePhaseInput[] = []
	for (const [phaseIndex, raw] of parsed.entries()) {
		if (!raw || typeof raw !== "object") return `phases.${phaseIndex} must be an object.`
		const phase = raw as Record<string, unknown>
		if (typeof phase.name !== "string") return `phases.${phaseIndex}.name must be a string.`
		if (typeof phase.goal !== "string") return `phases.${phaseIndex}.goal must be a string.`
		if (phase.description !== undefined && typeof phase.description !== "string") {
			return `phases.${phaseIndex}.description must be a string.`
		}
		const constraints = normalizeStringArray(phase.constraints, `phases.${phaseIndex}.constraints`)
		if (typeof constraints === "string") return constraints
		if (phase.budget !== undefined && typeof phase.budget !== "string")
			return `phases.${phaseIndex}.budget must be a string.`
		if (phase.parallel_group !== undefined && typeof phase.parallel_group !== "number") {
			return `phases.${phaseIndex}.parallel_group must be a number.`
		}
		if (phase.steps !== undefined) {
			if (!Array.isArray(phase.steps)) return `phases.${phaseIndex}.steps must be an array.`
			for (const [stepIndex, rawStep] of phase.steps.entries()) {
				if (!rawStep || typeof rawStep !== "object") return `phases.${phaseIndex}.steps.${stepIndex} must be an object.`
				const step = rawStep as Record<string, unknown>
				if (typeof step.description !== "string") {
					return `phases.${phaseIndex}.steps.${stepIndex}.description must be a string.`
				}
				if (step.verify !== undefined && typeof step.verify !== "string") {
					return `phases.${phaseIndex}.steps.${stepIndex}.verify must be a string.`
				}
				if (step.parallel_group !== undefined && typeof step.parallel_group !== "number") {
					return `phases.${phaseIndex}.steps.${stepIndex}.parallel_group must be a number.`
				}
			}
		}
		phases.push({
			name: phase.name as string,
			goal: phase.goal as string,
			description: phase.description as string | undefined,
			constraints,
			budget: phase.budget as string | undefined,
			parallel_group: phase.parallel_group as number | undefined,
			steps: phase.steps as ScopePhaseInput["steps"],
		})
	}
	return phases
}

function normalizeQuestions(value: ProposeScopingArgs["questions"]): ScopingQuestion[] | undefined | string {
	if (value === undefined) return undefined
	const parsed = parseJsonArray(value, "questions")
	if (typeof parsed === "string") return parsed
	if (parsed.length > 3) return 'Field "questions" must contain at most 3 questions.'
	const questions: ScopingQuestion[] = []
	for (const [questionIndex, raw] of parsed.entries()) {
		if (!raw || typeof raw !== "object") return `questions.${questionIndex} must be an object.`
		const q = raw as Record<string, unknown>
		if (typeof q.id !== "string") return `questions.${questionIndex}.id must be a string.`
		if (typeof q.question !== "string") return `questions.${questionIndex}.question must be a string.`
		const text = q.question
		const questionType = normalizeScopingQuestionType(q.type)
		if (!questionType.ok) return `questions.${questionIndex}.type ${questionType.error}`
		const type = questionType.type
		if (type === "text") {
			if (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 0)) {
				return `questions.${questionIndex}.options must be omitted or empty for text questions.`
			}
			questions.push({ id: q.id, text, type })
			continue
		}
		// confirm is always Yes/No and must not carry options.
		// Reject supplied options rather than silently rewriting them.
		if (questionType.isConfirm) {
			if (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 0)) {
				return `questions.${questionIndex}.options must be omitted for confirm questions — confirm is always Yes/No.`
			}
			questions.push({
				id: q.id,
				text,
				type,
				options: [...YES_NO_OPTIONS],
			})
			continue
		}
		if (!Array.isArray(q.options)) return `questions.${questionIndex}.options must be an array for ${type} questions.`
		if (q.options.length < 2 || q.options.length > 5) {
			return `questions.${questionIndex}.options must contain 2-5 options.`
		}
		for (const [optionIndex, rawOption] of q.options.entries()) {
			if (!rawOption || typeof rawOption !== "object") {
				return `questions.${questionIndex}.options.${optionIndex} must be an object.`
			}
			const option = rawOption as Record<string, unknown>
			if (typeof option.id !== "string") return `questions.${questionIndex}.options.${optionIndex}.id must be a string.`
			if (typeof option.label !== "string") {
				return `questions.${questionIndex}.options.${optionIndex}.label must be a string.`
			}
			if (option.recommended !== undefined && typeof option.recommended !== "boolean") {
				return `questions.${questionIndex}.options.${optionIndex}.recommended must be boolean.`
			}
		}
		questions.push({
			id: q.id,
			text,
			type: q.type === undefined ? undefined : type,
			options: q.options as ScopingQuestion["options"],
		})
	}
	return questions
}

function getScopingQuestionType(question: ScopingQuestion): ScopingQuestionType {
	const rawType = (question as { type?: unknown }).type
	if (rawType === undefined) return DEFAULT_SCOPING_QUESTION_TYPE
	if (rawType === "radio") return "single"
	if (rawType === "checkbox") return "multi"
	return rawType as ScopingQuestionType
}

function normalizeScopingQuestionType(
	value: unknown,
): { ok: true; type: ScopingQuestionType; isConfirm: boolean } | { ok: false; error: string } {
	if (value === undefined) return { ok: true, type: DEFAULT_SCOPING_QUESTION_TYPE, isConfirm: false }
	if (typeof value !== "string" || !SCOPING_QUESTION_TYPES.includes(value.toLowerCase() as ScopingQuestionType)) {
		return { ok: false, error: `must be ${SCOPING_QUESTION_TYPES.join(", ")}.` }
	}
	return { ok: true, ...toScopingQuestionType(value) }
}

function normalizeProposeScopingParams(params: ProposeScopingArgs): NormalizeProposeScopingResult {
	const title = normalizeFermentTitle(params.title)
	if (!title) return { ok: false, error: toolErr(TITLE_REQUIRED_ERROR) }
	const successCriteria = normalizeSuccessCriteriaInput(params.success_criteria)
	if (!successCriteria.ok) return { ok: false, error: toolErr(successCriteria.error) }
	const constraints = normalizeStringArray(params.constraints, "constraints")
	if (typeof constraints === "string") return { ok: false, error: toolErr(constraints) }
	const phases = normalizePhases(params.phases)
	if (typeof phases === "string") return { ok: false, error: toolErr(phases) }
	const questions = normalizeQuestions(params.questions)
	if (typeof questions === "string") return { ok: false, error: toolErr(questions) }
	return {
		ok: true,
		params: {
			...params,
			title,
			success_criteria: successCriteria.value,
			constraints,
			assumptions: normalizeAssumptions(params.assumptions),
			phases,
			questions,
		},
	}
}

function validateScopingQuestions(questions: ScopingQuestion[]): string | null {
	const questionIds = questions.map((q) => q.id)
	if (new Set(questionIds).size !== questionIds.length) {
		return "Question ids must be unique. Found duplicate question ids."
	}

	for (const q of questions) {
		const options = q.options ?? []
		const recommendedCount = options.filter((o) => o.recommended === true).length
		if (recommendedCount > 1) {
			return `Question "${q.id}" has ${recommendedCount} options with recommended: true. At most one option per question may be recommended.`
		}

		const optionIds = options.map((o) => o.id)
		if (new Set(optionIds).size !== optionIds.length) {
			return `Question "${q.id}" has duplicate option ids.`
		}
		const optionLabels = options.map((o) => o.label)
		if (new Set(optionLabels).size !== optionLabels.length) {
			return `Question "${q.id}" has duplicate option labels — labels must be distinct.`
		}
	}

	return null
}

export function buildPlanMarkdown(params: NormalizedProposeScopingArgs): string {
	const phaseBlocks = params.phases.map((p, i) => {
		const goalLines = wrapText(p.goal, 86)
		const stepLines = (p.steps ?? []).map((s, j) => renderStep(j + 1, s.description)).join("\n")
		return [
			`### Phase ${i + 1}: ${p.name}`,
			...goalLines.map((line, index) => (index === 0 ? `**Goal:** ${line}` : `          ${line}`)),
			stepLines ? `**Steps:**\n${stepLines}` : null,
		]
			.filter(Boolean)
			.join("\n")
	})
	return [
		`# Plan: ${params.title}`,
		"---",
		"",
		renderWrapped("## Goal", params.goal),
		"",
		renderBullets("## Success criteria", params.success_criteria ?? []),
		"",
		renderBullets("## Constraints", params.constraints ?? []),
		"",
		renderBullets("## Assumptions", splitListText(params.assumptions)),
		"",
		"## Phases",
		"---",
		"",
		phaseBlocks.join("\n\n"),
		"",
		"---",
	].join("\n")
}

function buildAnswersEntry(questions: ScopingQuestion[], answers: ScopingAnswer[]): string {
	const answerLines = answers.map((a, i) => {
		const q = questions.find((question) => question.id === a.questionId) ?? questions[i]
		const recMarker = a.recommended ? " ★" : ""
		return `Q${i + 1}: ${q.text}\n    · ${a.label}${recMarker}`
	})
	return `${pr_bold("Your answers")}\n${answerLines.join("\n")}`
}

function buildScopingIterationMessage(questions: ScopingQuestion[], answers: ScopingAnswer[]): string {
	const bundledAnswerLines = answers.map((a, i) => {
		const q = questions.find((question) => question.id === a.questionId) ?? questions[i]
		const answerText = a.optionId === "custom" ? `free-form: "${a.label}"` : `option "${a.optionId}" ("${a.label}")`
		return `- "${q.text}" → ${answerText}`
	})
	return `The user reviewed your draft and chose these answers (which OVERRIDE your recommendations):\n${bundledAnswerLines.join("\n")}\n\nRe-emit propose_ferment_scoping ONCE with updated goal/criteria/constraints/assumptions/phases reflecting these answers. Usually emit \`questions: []\` so the user can review the final plan. You may emit new questions only if these answers reveal a genuinely new, decision-blocking ambiguity; never repeat or rephrase any question answered above. Do NOT ask questions in chat — call the tool directly.`
}

function escapeXmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export function buildFreeformScopingFeedbackMessage(fermentId: string, userText: string): string {
	return [
		`User reviewed the pending plan for ferment_id "${fermentId}" and provided this feedback:`,
		"<user_feedback>",
		escapeXmlText(userText),
		"</user_feedback>",
		"",
		"Re-run propose_ferment_scoping for this same ferment_id, incorporating this direction. Do not call scope_ferment.",
	].join("\n")
}

type ResolveProposeTargetResult =
	| { ok: true; fermentId: string; created: boolean }
	| { ok: false; error: ReturnType<typeof toolErr> }

async function resolveProposeFermentTarget(
	runtime: FermentRuntime,
	pi: ExtensionAPI,
	ctx: unknown,
	rawId: string | undefined,
	title: string,
	goal: string,
): Promise<ResolveProposeTargetResult> {
	const storage = runtime.getStorage()
	if (rawId) {
		const existing = storage.get(rawId)
		if (existing) return { ok: true, fermentId: existing.id, created: false }
		if (runtime.getActive()) {
			return { ok: false, error: toolErr(`Ferment "${rawId}" not found.`) }
		}
		// Unknown id with no active ferment: fall through and create a new draft.
	}

	const active = runtime.getActive()
	if (active) return { ok: true, fermentId: active.id, created: false }

	// Bootstrap a new draft ferment from the proposal, mirroring /ferment new.
	const ui = (ctx as { ui?: FermentUi } | undefined)?.ui
	await ensureGitRepo({ ui })
	const shortName = deriveDraftFermentTitle(title)
	const f = storage.create(shortName, goal)
	setActiveFermentAndApplyProfile(pi, runtime, f)
	if (pi.events) {
		emitFermentCreated(pi.events, f)
	}
	appendRefEntry(pi, f.id)
	runtime.markScopingInteractive(f.id)
	runtime.setPendingScope(f.id, { goal: "", successCriteria: [], constraints: [] })
	return { ok: true, fermentId: f.id, created: true }
}

function formatCompletionCriteriaForReview(criteria: readonly string[]): string {
	return [`I'll consider this done when:`, ...criteria.map((criterion, index) => `${index + 1}. ${criterion}`)].join(
		"\n",
	)
}

async function confirmCompletionCriteria(
	runtime: FermentRuntime,
	pi: ExtensionAPI,
	params: ConfirmCompletionCriteriaArgs,
	ctx: unknown,
): Promise<ToolResult> {
	const ferment = runtime.getStorage().get(params.ferment_id)
	if (!ferment) return toolErr("Ferment not found.")

	const criteria = params.criteria.map((criterion) => criterion.trim()).filter(Boolean)
	if (criteria.length === 0) return toolErr('Field "criteria" must include at least one non-empty criterion.')

	const askContext = {
		ferment,
		pi,
		ctx: ctx as { ui?: Partial<import("../ui.js").FermentUi> } | undefined,
		runtime,
	}

	const response = await askUserForm(
		"Completion criteria",
		formatCompletionCriteriaForReview(criteria),
		[
			{
				id: "criteria_ok",
				type: "single",
				prompt: "Do these completion criteria look right?",
				options: [{ id: "yes", label: "Yes, looks good" }],
				allowOther: true,
				otherLabel: "No (input what is wrong)",
			},
		],
		askContext,
	)

	if (response.failed) {
		const isJudgeFailure = response.reason === "judge_unavailable" || response.reason === "judge_unparseable"
		const isOneShot = pi.getFlag?.("ferment-oneshot") === true
		if (isJudgeFailure && isOneShot) {
			const abandonOutcome = createApplyAndPersist(runtime)(params.ferment_id, {
				type: "abandon",
				reason: `confirm_ferment_completion_criteria: ${response.detail}`,
			})
			if (abandonOutcome.ok) runtime.setActive(abandonOutcome.ferment)
			return toolErr(
				`confirm_ferment_completion_criteria failed in one-shot mode — ferment abandoned. ${response.detail}\n\nThe ferment cannot continue without user input or a reachable judge. Restart with a valid API key, or run in interactive mode.`,
			)
		}
		return toolErr(
			`confirm_ferment_completion_criteria could not route the prompt (${response.reason}): ${response.detail}`,
		)
	}

	const answers = response.answers ?? []
	const decision = answers.find((answer) => answer.id === "criteria_ok")
	if (!decision) return toolErr("confirm_ferment_completion_criteria response was missing an answer.")
	const criteriaOk = decision.value === "yes"
	const changes = decision.wasCustom ? decision.value.trim() : ""
	const rationale = response.rationale
	const answeredBy = response.answered_by

	const ready = criteriaOk && changes.length === 0
	const rationaleLine = rationale ? `\nRationale: ${rationale}` : ""
	return toolOk(
		[
			"Completion criteria reviewed.",
			`Confirmed: ${criteriaOk ? "yes" : "no"}`,
			`Changes: ${changes || "(none)"}`,
			`Answered by: ${answeredBy}${rationaleLine}`,
			`Next action: ${
				ready
					? "continue to exploration."
					: `revise the criteria and call ${FERMENT_TOOLS.CONFIRM_COMPLETION_CRITERIA} again before exploration.`
			}`,
		].join("\n"),
	)
}

export async function scopeFerment(
	runtime: FermentRuntime,
	params: ScopeArgs,
	{ pi }: LifecycleExecutionContext,
): Promise<ToolResult> {
	const applyAndPersist = createApplyAndPersist(runtime)
	const title = normalizeFermentTitle(params.title)
	if (!title) return toolErr(TITLE_REQUIRED_ERROR)
	const successCriteria = normalizeSuccessCriteriaInput(params.success_criteria)
	if (!successCriteria.ok) return toolErr(successCriteria.error)

	// Plan-scope gate validation runs BEFORE any state mutation. The agent
	// must declare verifiable success signals (P1), composition (P2), and
	// the ferment-completion checklist (P3) before scoping is accepted.
	const gateError = validateGatesOrErr(params.gates, {
		turn: "scope_ferment",
		flagPolicy: "block-on-flag",
		renderFlagError: (count, lines) =>
			`Cannot scope ferment — agent self-flagged on ${count} plan gate(s):\n\n${lines}\n\nRevise the plan (e.g. give each phase a verifiable success signal, declare a concrete checklist for complete_ferment) and call scope_ferment again with passing P-gate verdicts.`,
	})
	if (gateError) return gateError

	// Hard gate: only enforced for ferments scoped through the interactive TUI
	// path. Headless and one-shot scoping never mark this gate as interactive.
	const fGate = runtime.getStorage().get(params.ferment_id)
	const gateActive = runtime.isScopingInteractive(params.ferment_id)
	if (gateActive && !runtime.isScopingConfirmed(params.ferment_id)) {
		const pending = runtime.getPendingScope(params.ferment_id)
		const pendingHint =
			pending?.phases && pending.phases.length > 0
				? "A structured proposal is pending in the interactive scoping flow. Do not call scope_ferment directly; the host confirmation must come from propose_ferment_scoping."
				: "No valid structured proposal has reached the host yet. Call propose_ferment_scoping with the full payload so the host can render the confirmation dropdown."
		return toolErr(
			[
				`Cannot call scope_ferment for interactive ferment "${params.ferment_id}" before host confirmation.`,
				pendingHint,
				"Retry by calling propose_ferment_scoping with the full valid payload: title, goal, success_criteria, constraints, assumptions, phases, questions, and gates.",
				"If a previous propose_ferment_scoping call failed validation, fix that schema error and re-emit the same plan.",
				"Do not summarize the plan in chat. Do not call scope_ferment directly.",
			].join("\n"),
		)
	}
	runtime.consumeScopingGate(params.ferment_id)

	// FSM validation: ensure the scope transition is allowed before applying it.
	const fsmError = validateFsmTransition(fGate, "SCOPE_FERMENT")
	if (fsmError) return toolErrWithNextAction(fsmError, fGate)

	const cmd: Command = {
		type: "scope",
		title,
		goal: params.goal,
		successCriteria: successCriteria.value,
		constraints: params.constraints,
		assumptions: normalizeAssumptions(params.assumptions),
		phases: params.phases ?? [],
	}
	const outcome = applyAndPersist(params.ferment_id, cmd)
	if (!outcome.ok) {
		// Special-case: ferment-not-in-status with current "planned"/"running" maps
		// to the user-friendly "use update_ferment_scope_field to revise" hint.
		if (outcome.error.code === "FERMENT_NOT_IN_STATUS" && outcome.error.actual !== "draft") {
			return toolErr(
				withNextActionHint(
					`Ferment is already ${outcome.error.actual}. Use update_ferment_scope_field to revise individual fields.`,
					fGate,
				),
			)
		}
		return failedToolResult(outcome.error, fGate)
	}
	// Discard any stale pending-scope buffer — its phases were either applied
	// here or are no longer relevant (the ferment is now planned).
	runtime.clearPendingScope(params.ferment_id)

	const fresh = outcome.ferment
	const phaseList = fresh.phases.map((p) => `  [${p.id}] ${p.index}. ${p.name} — ${p.goal}`).join("\n") || "(none)"

	runtime.setActive(fresh)

	return toolOk(
		withNextActionHint(
			`**Ferment "${fresh.name}"** scoped and ready.\n\n- **ferment_id:** ${fresh.id}\n- **Goal:** ${params.goal}\n\n**Phases:**\n${phaseList}`,
			fresh,
		),
	)
}

export async function completeFerment(runtime: FermentRuntime, params: CompleteFermentArgs): Promise<ToolResult> {
	const applyAndPersist = createApplyAndPersist(runtime)

	const fSnapshot = runtime.getStorage().get(params.ferment_id)
	if (!fSnapshot) return toolErr("Ferment not found.")
	if (fSnapshot.status === "complete") {
		runtime.clearFermentState(params.ferment_id)
		resetReactiveContinuationNudgeCount(params.ferment_id)
		runtime.setActive(undefined)
		return toolOk(
			`Ferment "${fSnapshot.name}" is already complete. No further lifecycle action is available. Do not act on this ferment again without clear user consent.`,
		)
	}
	if (fSnapshot.status === "abandoned") {
		runtime.clearFermentState(params.ferment_id)
		resetReactiveContinuationNudgeCount(params.ferment_id)
		runtime.setActive(undefined)
		return toolErr(`Ferment "${fSnapshot.name}" is abandoned and cannot be completed.`)
	}

	// Ferment-scope gate validation runs BEFORE any state mutation. The agent
	// must answer C1 (success criteria satisfied), C2 (no unresolved F3
	// deferrals), C3 (real verification ran the artifact) before ship is
	// allowed. A flag on any gate refuses ship.
	const gateError = validateGatesOrErr(params.gates, {
		turn: "complete_ferment",
		flagPolicy: "block-on-flag",
		renderFlagError: (count, lines) =>
			`complete_ferment refused — agent self-flagged on ${count} ferment gate(s):\n\n${lines}\n\nAddress the concern(s) and call complete_ferment again with passing C-gate verdicts.`,
	})
	if (gateError) return gateError
	const gates = params.gates ?? []

	// Journey-grade judge: reads per-phase F-gate verdicts from the on-disk
	// review-evidence sidecars, the C-gates the agent just provided, the goal
	// + success criteria, and the total diff. Produces a pessimistic A–F
	// grade with rationale. C-gates already decided ship/refuse — the judge
	// only measures HOW WELL the work was done.
	const ferment = fSnapshot
	const phaseReviews = readLatestPhaseReviews(ferment.id)
	const totalDiff = ferment.worktree.commit ? gatherPhaseEvidence(ferment.worktree.commit) : undefined
	const journeyResult = await judgeJourneyGrade({
		fermentName: ferment.name,
		goal: ferment.goal ?? "",
		successCriteria: renderSuccessCriteria(ferment.successCriteria, ""),
		finalSummary: params.final_summary ?? "",
		phases: ferment.phases.map((p) => {
			const review = phaseReviews.get(p.id)
			return {
				name: p.name,
				goal: p.goal,
				status: p.status,
				gateVerdicts: review?.gateVerdicts?.map((v) => ({
					id: v.id,
					verdict: v.verdict,
					rationale: v.rationale,
				})),
			}
		}),
		fermentGates: gates.map((g) => ({ id: g.id, verdict: g.verdict, rationale: g.rationale })),
		totalDiff: totalDiff
			? { available: totalDiff.available, filesChanged: totalDiff.filesChanged, diffSnippet: totalDiff.diffSnippet }
			: { available: false },
	})

	// Resolve the grade. The final judge is advisory; completion gates have
	// already decided whether shipping is allowed, so judge outages must not
	// block the user.
	let resolvedGrade: { grade: Grade; rationale: string } | undefined
	let gradeRationale: string
	if (journeyResult.ok) {
		resolvedGrade = { grade: journeyResult.grade, rationale: journeyResult.rationale }
		gradeRationale = journeyResult.rationale
	} else {
		const failureDetail = `${journeyResult.reason}${journeyResult.detail ? `: ${journeyResult.detail}` : ""}`
		gradeRationale = `Judge unreachable (${failureDetail}); completion proceeded without a graded review.`
	}

	// Persist completion and grade together when the advisory judge returns one.
	const completeOutcome = applyAndPersist(params.ferment_id, {
		type: "complete_ferment",
		finalSummary: params.final_summary,
		grade: resolvedGrade
			? {
					grade: resolvedGrade.grade,
					rationale: resolvedGrade.rationale,
					gradedAt: runtime.nowIso(),
				}
			: undefined,
	})
	if (!completeOutcome.ok) return failedToolResult(completeOutcome.error, ferment)

	// Cleanup in-memory state.
	runtime.clearFermentState(params.ferment_id)
	resetReactiveContinuationNudgeCount(params.ferment_id)
	runtime.setActive(undefined)

	const fresh = completeOutcome.ferment
	const failedPhases = fresh.phases.filter((p) => p.status === "failed").length
	const failedNote = failedPhases > 0 ? ` (${failedPhases} phase(s) failed)` : ""
	const gateLines = gates.map((g) => `  ${g.id} (${g.verdict}): ${g.rationale}`).join("\n")
	const gradeLabel = resolvedGrade?.grade ?? "unavailable"
	const terminalNotice = `This ferment is complete and terminal. Do not call bash/read/list_ferments or any ferment tools for this ferment again without clear user consent. If the user wants a new ferment, tell them to run \`/ferment new "..."\` or \`/ferment one-shot "..."\` — do not search MCP tools or invent a tool.`

	return toolOk(
		`**Ferment "${fresh.name}"** complete${failedNote}.\n\n---\n\n**Final gates:**\n${gateLines}\n\n**Final grade:** ${gradeLabel} — ${gradeRationale}\n\n${params.final_summary ?? ""}\n\n---\n\n${terminalNotice}`,
	)
}

export function registerLifecycleTools(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	const applyAndPersist = createApplyAndPersist(runtime)

	pi.registerTool({
		name: FERMENT_TOOLS.PROPOSE_SCOPING,
		label: "Propose Scoping",
		description: `Emit the full scoping draft: title, goal, success_criteria (array of acceptance criteria), constraints, assumptions, 1-7 phases, questions, and gates. title is required and must be a concise 3-5 word Ferment name. ferment_id is optional; omit it when no ferment is active and the host will create a new draft ferment from this proposal. If the agent has decision-blocking scoping questions, they must be included in the questions array in this tool call; each question should use the canonical field name question for the user-visible question sentence; do not ask scoping questions in chat after calling this tool. For broad discovery or planning over an existing codebase, multiple plausible work areas are an outcome/scope boundary; ask one multi question unless the user explicitly asked to implement all of them. Example: "Which improvement areas should this ferment include?" Use questions: [] when no decision-blocking question remains. Questions pause planning; after answers, re-emit the updated proposal with questions: []. If questions is non-empty, keep phases provisional and answer-agnostic. Every call must include the full gates array: exactly P1, P2, and P3, each with id, verdict, rationale, and evidence. Partial gates are rejected. Prefer one phase for simple tasks and assumptions over default-choice questions.

${renderGateGuidance("scope_ferment")}`,
		parameters: ProposeScopingParams,
		prepareArguments: assertGateFieldsPresent,
		renderResult(result) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : ""
			return new Markdown(text, 1, 0, getMarkdownTheme())
		},
		async execute(_, rawParams, _signal, _onUpdate, ctx) {
			clearScopingStatus(ctx)
			const normalized = normalizeProposeScopingParams(rawParams)
			if (!normalized.ok) return normalized.error
			const params = normalized.params

			// 1. Validate P-gates (same as scopeFerment).
			const gateError = validateGatesOrErr(params.gates, {
				turn: "scope_ferment",
				flagPolicy: "block-on-flag",
				renderFlagError: (count, lines) =>
					`Cannot propose scoping — agent self-flagged on ${count} plan gate(s):\n\n${lines}\n\nRevise the plan and call propose_ferment_scoping again with passing P-gate verdicts.`,
			})
			if (gateError) return gateError

			// 2. Extra validation: at most one recommended per question, unique ids.
			const questions = params.questions ?? []
			const questionValidationError = validateScopingQuestions(questions)
			if (questionValidationError) return toolErr(questionValidationError)

			// 3. Resolve the target ferment. If no id is given and no active ferment
			// exists, bootstrap a new draft from the proposal.
			const resolveResult = await resolveProposeFermentTarget(
				runtime,
				pi,
				ctx,
				params.ferment_id,
				params.title,
				params.goal,
			)
			if (!resolveResult.ok) return resolveResult.error
			const { fermentId, created: createdFerment } = resolveResult

			// 4. Replace pending buffer wholesale.
			const ferment = runtime.getStorage().get(fermentId)
			if (!ferment) return toolErr(`Ferment "${fermentId}" not found.`)
			if (ferment.status !== "draft") {
				const nextAction =
					ferment.status === "planned" ? "call activate_ferment_phase" : "continue the current ferment action"
				return toolOk(
					withNextActionHint(
						`Ferment "${ferment.name}" is already ${ferment.status}; ignore this duplicate propose_ferment_scoping call and ${nextAction}.`,
						ferment,
					),
				)
			}

			const pending = runtime.getPendingScope(fermentId)
			if (!pending) {
				// Seed an empty buffer so attachPendingProposal can replace it.
				runtime.setPendingScope(fermentId, { goal: "", successCriteria: [], constraints: [] })
			}
			const pendingAfterSeed: PendingScope = runtime.getPendingScope(fermentId) ?? {
				goal: "",
				successCriteria: [],
				constraints: [],
			}

			// Iteration cap: prevent infinite propose_ferment_scoping loops.
			const currentIterations = pendingAfterSeed.proposeIterations ?? 0
			const nextIterations = currentIterations + 1
			if (currentIterations >= 3 && questions.length > 0) {
				return toolErr(
					"You've proposed scoping 3 times. Pick the best draft and emit propose_ferment_scoping with questions=[] to let the user confirm.",
				)
			}

			runtime.attachPendingProposal(fermentId, {
				title: params.title,
				goal: params.goal,
				successCriteria: params.success_criteria,
				constraints: params.constraints,
				assumptions: params.assumptions,
				phases: params.phases,
				proposeIterations: nextIterations,
			})

			// 4. Build clean markdown for final/headless tool output and local review UI.
			const planEntry = buildPlanMarkdown(params)
			const formatPlanEntry = (suffix?: string): string => (suffix ? `${planEntry}\n\n${suffix}` : planEntry)
			const planToolOk = (message: string, options: { includePlan?: boolean; suffix?: string } = {}) =>
				toolOk(options.includePlan ? `${formatPlanEntry(options.suffix)}\n\n${message}` : message)
			const promptUi = getPromptUi(ctx)

			// 5. Headless path.
			if (!promptUi?.select && !promptUi?.custom) {
				if (questions.length === 0) {
					const scopeOutcome = confirmPendingScope(runtime, fermentId, params.phases, "propose_ferment_scoping", pi)
					if (!scopeOutcome.ok) return failedToolResult(scopeOutcome.error, ferment)
					return planToolOk(withNextActionHint("Plan saved.", scopeOutcome.outcome.ferment), { includePlan: true })
				}
				const recSummary = questions
					.map((q) => {
						if (getScopingQuestionType(q) === "text") return `${q.id}: custom text required`
						const rec = (q.options ?? []).find((o) => o.recommended) ?? (q.options ?? [])[0]
						return `${q.id}: ${rec?.id ?? "no recommendation"}`
					})
					.join(", ")
				return toolErr(
					`Cannot ask scoping questions without an interactive UI. Re-emit propose_ferment_scoping with those recommendations folded into goal/criteria/constraints/assumptions/phases and questions=[].\nRecommended answers: ${recSummary}`,
				)
			}

			// 6. Zero-questions path: defer the local review dialog until the
			// agent turn ends, so terminal scrollback is not fighting active-turn
			// progress writes.
			if (questions.length === 0) {
				if (!promptUi?.custom) {
					// Some hosts expose select/input without custom components; keep them on the pre-review confirmation path.
					const scopeOutcome = confirmPendingScope(runtime, fermentId, params.phases, "propose_ferment_scoping", pi)
					if (!scopeOutcome.ok) return failedToolResult(scopeOutcome.error, ferment)
					return planToolOk(
						withNextActionHint(
							`Plan saved. Ferment "${scopeOutcome.outcome.ferment.name}" is planned with ${scopeOutcome.outcome.ferment.phases.length} phase(s). Starting execution.`,
							scopeOutcome.outcome.ferment,
						),
						{ includePlan: true },
					)
				}

				runtime.setPendingPlanReview({
					fermentId,
					planMarkdown: planEntry,
				})
				return planToolOk("Plan ready for review. The review dialog will open when this turn finishes.")
			}

			// 7. Tabbed question form + review loop.
			const runQuestions = async (): Promise<ScopingAnswer[] | "cancelled" | { kind: "dismiss"; qn: number }> => {
				if (
					!getPromptUi(ctx)?.custom &&
					questions.every((q) => {
						const type = getScopingQuestionType(q)
						return type === "single" || type === "confirm"
					})
				) {
					const answers: ScopingAnswer[] = []
					const customLabel = `✎ ${pr_dim("Custom answer...")}`
					for (let n = 0; n < questions.length; n++) {
						const q = questions[n]
						const questionType = getScopingQuestionType(q)
						const labeledOptions = (q.options ?? []).map((o) => ({
							option: o,
							label: o.recommended === true ? `${o.label}  ★ Recommended` : o.label,
						}))
						const optionLabels = labeledOptions.map((o) => o.label)
						if (questionType === "single") optionLabels.push(customLabel)

						const title = `[Q${n + 1}/${questions.length}] ${q.text}`
						const chosen = await promptSelect(ctx, title, optionLabels)
						if (chosen === undefined) return { kind: "dismiss", qn: n + 1 }
						if (questionType === "single" && chosen === customLabel) {
							const freeForm = await promptEditor(ctx, `[Q${n + 1}/${questions.length}] Your answer for: ${q.text}`)
							if (!freeForm) return "cancelled"
							answers.push({ questionId: q.id, optionId: "custom", label: freeForm, recommended: false })
							continue
						}
						const matched = labeledOptions.find((o) => o.label === chosen)
						if (matched) {
							answers.push({
								questionId: q.id,
								optionId: matched.option.id,
								label: matched.option.label,
								recommended: matched.option.recommended === true,
							})
						}
					}
					return answers
				}

				const result = await promptForm(ctx, {
					questions: questions.map((q, index) => ({
						id: q.id,
						type: getScopingQuestionType(q),
						label: `Q${index + 1}`,
						prompt: q.text,
						options: (q.options ?? []).map((o) => ({
							id: o.id,
							label: o.recommended === true ? `${o.label}  ★ Recommended` : o.label,
						})),
						allowOther: getScopingQuestionType(q) === "single" || getScopingQuestionType(q) === "multi",
					})),
				})
				if (!result) return { kind: "dismiss", qn: 1 }
				if (result.cancelled) return "cancelled"

				const answers: ScopingAnswer[] = []
				for (const q of questions) {
					const answer = result.answers.find((a) => a.id === q.id)
					if (!answer) return { kind: "dismiss", qn: questions.indexOf(q) + 1 }
					const questionType = getScopingQuestionType(q)
					if (questionType === "text") {
						answers.push({ questionId: q.id, optionId: "custom", label: answer.label, recommended: false })
						continue
					}
					if (questionType === "multi") {
						const values = answer.values ?? [answer.value]
						const labels = values.map(
							(value, index) => (q.options ?? []).find((o) => o.id === value)?.label ?? answer.labels?.[index] ?? value,
						)
						answers.push({
							questionId: q.id,
							optionId: values.join(", "),
							label: labels.join(", "),
							recommended: false,
						})
						continue
					}
					if (answer.wasCustom) {
						answers.push({ questionId: q.id, optionId: "custom", label: answer.label, recommended: false })
						continue
					}
					const matched = (q.options ?? []).find((o) => o.id === answer.value)
					if (!matched) return { kind: "dismiss", qn: questions.indexOf(q) + 1 }
					answers.push({
						questionId: q.id,
						optionId: matched.id,
						label: matched.label,
						recommended: matched.recommended === true,
					})
				}
				return answers
			}

			// Outer loop: supports "Restart questions".
			while (true) {
				const answersResult = await runQuestions()

				if (answersResult === "cancelled") {
					return planToolOk("Question flow cancelled. Waiting for your next instruction.")
				}
				if (typeof answersResult === "object" && "kind" in answersResult) {
					return planToolOk(`Question Q${answersResult.qn} dismissed. Waiting for your next instruction.`)
				}

				const answers = answersResult

				const answersEntry = buildAnswersEntry(questions, answers)
				if (getPromptUi(ctx)?.custom) {
					const content = buildScopingIterationMessage(questions, answers)
					void pi.sendMessage(
						{ content, customType: "ferment_scoping_iteration", display: false },
						{ triggerTurn: true },
					)
					return planToolOk(`${answersEntry}\n\nAnswers recorded. Updating the plan with your choices...`)
				}

				const continueLabel = "Update plan  ✓"
				const reviewOptions = [continueLabel, "Restart questions", "Let me say something"]

				const reviewTitle = `${answersEntry}\n\nUpdate the plan with these answers?`
				const reviewChoice = await promptSelect(ctx, reviewTitle, reviewOptions)

				if (reviewChoice === undefined) {
					return planToolOk("Review dismissed. Waiting for your next instruction.")
				}
				if (reviewChoice === "Restart questions") {
					// Loop back to per-question screens.
					continue
				}

				if (reviewChoice === "Let me say something") {
					const userText = await promptEditor(ctx, "Your direction:")
					if (!userText) {
						return planToolOk(`${answersEntry}\n\nNo changes made. Waiting for your next instruction.`)
					}
					const sayMoreContent = buildFreeformScopingFeedbackMessage(fermentId, userText)
					void pi.sendMessage(
						{ content: sayMoreContent, customType: "ferment_scoping_iteration", display: false },
						{ triggerTurn: true },
					)
					return planToolOk(`${answersEntry}\n\nGot it. Updating the plan with your direction...`)
				}

				const content = buildScopingIterationMessage(questions, answers)
				void pi.sendMessage({ content, customType: "ferment_scoping_iteration", display: false }, { triggerTurn: true })
				return planToolOk(`${answersEntry}\n\nAnswers recorded. Updating the plan with your choices...`)
			}
		},
	})

	pi.registerTool({
		name: FERMENT_TOOLS.LIST,
		label: "List Ferments",
		description:
			"List all ferments. Filter by status if needed (draft/planned/running/paused/complete/abandoned). The active ferment is marked.",
		parameters: ListParams,
		async execute(_, params) {
			const items = runtime.getStorage().list()
			// Normalize filter: "active" is not a status — "running" is the running state
			const filterValue = params.filter === "active" ? "running" : params.filter
			const filtered = filterValue ? items.filter((f) => f.status === filterValue) : items
			if (filtered.length === 0) {
				return toolOk(filterValue ? `No ferments with status "${filterValue}".` : "No ferments.")
			}
			const activeId = runtime.getActiveId()
			const lines = filtered.map((f) => {
				const active = f.id === activeId ? " ← active" : ""
				return `- ${f.id} │ ${f.name} [${f.status}] — ${f.phaseCount} phases${active}`
			})
			return toolOk(`**Ferments:**\n${lines.join("\n")}`)
		},
		renderResult(result) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : ""
			return new Markdown(text, 1, 0, getMarkdownTheme())
		},
	})

	pi.registerTool({
		name: FERMENT_TOOLS.SCOPE,
		label: "Scope Ferment",
		description: `Save scoping answers and transition ferment from draft to planned. success_criteria is an array of acceptance criteria. title is required and must be a concise 3-5 word Ferment name. In interactive scoping, the harness gates this call until the user has confirmed the proposed plan via TUI dropdown. You must produce verdicts for the three plan-scope gates below. A "flag" verdict refuses scoping.

${renderGateGuidance("scope_ferment")}`,
		parameters: ScopeParams,
		prepareArguments: assertGateFieldsPresent,
		renderResult(result) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : ""
			return new Markdown(text, 1, 0, getMarkdownTheme())
		},
		async execute(_, params) {
			return scopeFerment(runtime, params, { pi })
		},
	})

	pi.registerTool({
		name: FERMENT_TOOLS.UPDATE_SCOPE_FIELD,
		label: "Update Scope Field",
		description:
			"Revise a single scoping field (goal, criteria, constraints, assumptions) on an already-planned ferment.",
		parameters: UpdateScopeFieldParams,
		async execute(_, params) {
			if (
				params.field !== "goal" &&
				params.field !== "criteria" &&
				params.field !== "constraints" &&
				params.field !== "assumptions"
			) {
				return toolErr(`Unknown field: ${params.field}. Use goal, criteria, constraints, or assumptions.`)
			}
			const outcome = applyAndPersist(params.ferment_id, {
				type: "update_scope_field",
				field: params.field,
				value: params.value,
			})
			if (!outcome.ok) return failedToolResult(outcome.error)
			return toolOk(
				withNextActionHint(`Field "${params.field}" updated for "${outcome.ferment.name}".`, outcome.ferment),
			)
		},
	})

	pi.registerTool({
		name: FERMENT_TOOLS.COMPLETE,
		label: "Complete Ferment",
		description: `Mark ferment as complete. All phases must be terminal (completed, skipped, or failed). You must produce verdicts for the three ferment-scope gates below. A "flag" verdict refuses ship.

${renderGateGuidance("complete_ferment")}`,
		parameters: CompleteFermentParams,
		prepareArguments: assertGateFieldsPresent,
		renderResult(result) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : ""
			return new Markdown(text, 1, 0, getMarkdownTheme())
		},
		async execute(_, params) {
			return completeFerment(runtime, params)
		},
	})

	// confirm_ferment_completion_criteria and ask_user both render interactive
	// TUI forms via ctx.ui.custom(). Hide them from the system prompt when no
	// UI is attached and the ferment-oneshot judge fallback is not engaged,
	// so the LLM does not call a tool that cannot succeed.
	const interactiveVisibility = createToolVisibility(pi)
	pi.on("session_start", (_event, ctx) => {
		const judgeFallback = pi.getFlag?.("ferment-oneshot") === true
		const hideInteractiveTools = !ctx.hasUI && !judgeFallback
		const interactiveTools = [FERMENT_TOOLS.CONFIRM_COMPLETION_CRITERIA, FERMENT_TOOLS.ASK_USER]
		if (hideInteractiveTools) {
			interactiveVisibility.disable(interactiveTools)
		} else {
			interactiveVisibility.enable(interactiveTools)
		}
	})

	pi.registerTool({
		name: FERMENT_TOOLS.CONFIRM_COMPLETION_CRITERIA,
		label: "Confirm Completion Criteria",
		description: `Confirm drafted Ferment completion criteria with deterministic UI. Use this in Step 3 after drafting criteria; do not hand-build completion-criteria confirmation with ask_user.

The host renders one question:
  - "Yes, looks good"
  - "No (input what is wrong)" with inline free-form text input for the explanation

Proceed to exploration only when Confirmed is yes and Changes is empty.
If the user answers No, the follow-up captures textual changes and control returns here for revision.`,
		parameters: ConfirmCompletionCriteriaParams,
		async execute(_, params, _signal, _onUpdate, ctx) {
			return confirmCompletionCriteria(runtime, pi, params, ctx)
		},
	})

	pi.registerTool({
		name: FERMENT_TOOLS.ASK_USER,
		label: "Ask User",
		description: `Ask the user a structured question. Use ONLY at genuine decision points the agent cannot resolve from context (e.g. ambiguous requirements, choice between viable approaches, user-only authorization).

Behavior depends on session mode:
  - Interactive (with TUI): the user answers in a structured TUI. Returns { choice | choices | text | answers, answered_by: "user" }.
  - One-shot (no human attached): the configured judge model stands in for the user. Returns { choice | choices | text | answers, answered_by: "judge", rationale }.

Hard contract: in one-shot mode, if the judge is unreachable (no API key, timeout, unparseable response) the ferment is ABANDONED — there is no fallback. False-pass is the worst outcome.

The agent should:
  1. Frame the question concretely. The user/judge sees only the question plus options/context in this call.
  2. Prefer questions[] for the full TUI: single, multi, text, confirm. allowOther is only for single/multi custom free-text options.
  3. Use response_type="single" | "multi" | "text" | "confirm" only as a compatibility shorthand for one question.
  4. Treat response_type="confirm" as strict Yes/No only. Use response_type="text" for one free-form question, or questions[] when multiple controls are needed.
  5. For single/multi, provide stable snake-case option ids and short labels (confirm defaults to Yes/No).
  6. Include "pause" or "abandon" as an explicit option when one is appropriate — the judge prefers these when uncertain.
  7. Act on the returned \`answers\`, \`choice\`, \`choices\`, or \`text\` field.

TUI controls for questions[]:
  - Tab / Shift+Tab moves between questions
  - Up/Down navigates options
  - Space toggles multi-select options
  - Enter selects an option / submits text / advances
  - Esc cancels

Returns structured answer fields on success, or a tool error if no audience can be reached.`,
		parameters: AskUserParams,
		async execute(_, params, _signal, _onUpdate, ctx) {
			const applyAndPersist = createApplyAndPersist(runtime)
			const ferment = runtime.getStorage().get(params.ferment_id)
			if (!ferment) return toolErr("Ferment not found.")

			const askContext = {
				ferment,
				pi,
				ctx: ctx as { ui?: Partial<import("../ui.js").FermentUi> } | undefined,
				runtime,
			}
			let normalizedQuestions: AskUserQuestion[] | undefined
			if (params.questions && params.questions.length > 0) {
				const normalizeResult = normalizeAskUserQuestions(params.questions)
				if (!normalizeResult.ok) return toolErr(normalizeResult.error)
				normalizedQuestions = normalizeResult.questions
			}
			const response = normalizedQuestions
				? await askUserForm(params.title ?? params.question, params.description, normalizedQuestions, askContext)
				: params.question
					? await askUser(params.question, params.options ?? [], askContext, params.response_type ?? "single")
					: undefined

			if (!response) {
				return toolErr("ask_user requires either question or questions[].")
			}

			if (response.failed) {
				// One-shot hard-fail: when the judge is the only legitimate audience
				// and it can't be reached, the ferment must abandon. Per the design
				// contract, false-pass is unacceptable in unattended runs.
				const isJudgeFailure = response.reason === "judge_unavailable" || response.reason === "judge_unparseable"
				const isOneShot = pi.getFlag?.("ferment-oneshot") === true
				if (isJudgeFailure && isOneShot) {
					const abandonOutcome = applyAndPersist(params.ferment_id, {
						type: "abandon",
						reason: `ask_user: ${response.detail}`,
					})
					if (abandonOutcome.ok) runtime.setActive(abandonOutcome.ferment)
					return toolErr(
						`ask_user failed in one-shot mode — ferment abandoned. ${response.detail}\n\nThe ferment cannot continue without user input or a reachable judge. Restart with a valid API key, or run in interactive mode.`,
					)
				}
				return toolErr(`ask_user could not route the question (${response.reason}): ${response.detail}`)
			}

			const rationaleLine = response.rationale ? `\nRationale: ${response.rationale}` : ""
			const answerLine =
				response.response_type === "form"
					? `Answers:\n${(response.answers ?? [])
							.map((answer) => {
								const value = answer.values ? answer.values.join(", ") : answer.value
								return `- ${answer.id}: ${value}${answer.wasCustom ? " (custom)" : ""}`
							})
							.join("\n")}`
					: response.response_type === "multi"
						? `Choices: ${(response.choices ?? []).join(", ")}`
						: response.response_type === "text"
							? `Text: ${response.text ?? ""}`
							: `Choice: ${response.choice ?? ""}`
			return toolOk(`Answer received.\n${answerLine}\nAnswered by: ${response.answered_by}${rationaleLine}`)
		},
	})
}
