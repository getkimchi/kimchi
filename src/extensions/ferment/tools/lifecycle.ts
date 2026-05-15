/**
 * Ferment lifecycle tools: create, list, scope, update fields, set mode, complete.
 *
 * Tool handlers follow the pattern:
 *   1. Validate UI-flow gates (scoping confirmation, etc.) — host concern
 *   2. Build a Command and call applyAndPersist — state machine concern
 *   3. Run side effects (judge calls, nudges) — host concern
 *   4. Format result text — host concern
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Static } from "typebox"
import type { Command, ScopePhaseInput } from "../../../ferment/state-machine.js"
import type { Grade, ScopingQuestion } from "../../../ferment/types.js"
import { askUser, askUserForm } from "../ask-user.js"
import { pr_bold, pr_dim } from "../colors.js"
import { validateFsmTransitionWithFerment } from "../fsm-adapter.js"
import { renderGateGuidance } from "../gate-registry.js"
import { validateGatesOrErr } from "../gate-validation.js"
import { autoInitFromEnv, ensureGitRepo } from "../git-init.js"
import { judgeJourneyGrade } from "../judge.js"
import { appendRefEntry, injectResumeAutoNudge, resetReactiveAutoNudgeCount } from "../nudge.js"
import { gatherPhaseEvidence } from "../phase-evidence.js"
import { getPromptUi, promptForm, promptInput, promptSelect } from "../prompt-ui.js"
import { readLatestPhaseReviews } from "../review-evidence.js"
import { type FermentRuntime, defaultFermentRuntime } from "../runtime.js"
import { confirmPendingScope } from "../scoping-confirmation.js"
import { createApplyAndPersist, failedToolResult, toolErr, toolOk } from "../tool-helpers.js"
import {
	AskUserParams,
	CompleteFermentParams,
	CreateFermentParams,
	ListParams,
	ProposeScopingParams,
	ScopeParams,
	SetModeParams,
	UpdateScopeFieldParams,
} from "../tool-schemas.js"
import { setActiveFerment, syncFermentToolScope } from "../tool-scope.js"

type ScopeArgs = Static<typeof ScopeParams>
type ProposeScopingArgs = Static<typeof ProposeScopingParams>
type NormalizedProposeScopingArgs = Omit<ProposeScopingArgs, "constraints" | "phases" | "questions" | "assumptions"> & {
	constraints?: string[]
	assumptions?: string
	phases: ScopePhaseInput[]
	questions?: ScopingQuestion[]
}
type NormalizeProposeScopingResult =
	| { ok: true; params: NormalizedProposeScopingArgs }
	| { ok: false; error: ReturnType<typeof toolErr> }
type CompleteFermentArgs = Static<typeof CompleteFermentParams>
type ToolResult = ReturnType<typeof toolOk> | ReturnType<typeof toolErr>
type ScopingAnswer = {
	questionId: string
	optionId: string
	label: string
	recommended: boolean
}

export interface LifecycleExecutionContext {
	pi: ExtensionAPI
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
	const lines = wrapText(description, 82)
	if (lines.length === 0) return `${index}. —`
	return lines.map((line, lineIndex) => (lineIndex === 0 ? `${index}. ${line}` : `   ${line}`)).join("\n")
}

function normalizeAssumptions(value: unknown): string | undefined {
	if (value === undefined || typeof value !== "string") return value as string | undefined
	const trimmed = value.trim()
	if (!trimmed.startsWith("[")) return value
	try {
		const parsed = JSON.parse(trimmed)
		if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
			return parsed.join("; ")
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
	if (parsed.length < 3) return 'Field "phases" must contain at least 3 phases.'
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
	for (const [questionIndex, raw] of parsed.entries()) {
		if (!raw || typeof raw !== "object") return `questions.${questionIndex} must be an object.`
		const q = raw as Record<string, unknown>
		if (typeof q.id !== "string") return `questions.${questionIndex}.id must be a string.`
		if (typeof q.text !== "string") return `questions.${questionIndex}.text must be a string.`
		if (!Array.isArray(q.options)) return `questions.${questionIndex}.options must be an array.`
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
	}
	return parsed as ScopingQuestion[]
}

function normalizeProposeScopingParams(params: ProposeScopingArgs): NormalizeProposeScopingResult {
	const constraints = normalizeStringArray(params.constraints, "constraints")
	if (typeof constraints === "string") return { ok: false, error: toolErr(constraints) }
	const phases = normalizePhases(params.phases)
	if (typeof phases === "string") return { ok: false, error: toolErr(phases) }
	const questions = normalizeQuestions(params.questions)
	if (typeof questions === "string") return { ok: false, error: toolErr(questions) }
	return {
		ok: true,
		params: { ...params, constraints, assumptions: normalizeAssumptions(params.assumptions), phases, questions },
	}
}

function validateScopingQuestions(questions: ScopingQuestion[]): string | null {
	const questionIds = questions.map((q) => q.id)
	if (new Set(questionIds).size !== questionIds.length) {
		return "Question ids must be unique. Found duplicate question ids."
	}

	for (const q of questions) {
		const recommendedCount = q.options.filter((o) => o.recommended === true).length
		if (recommendedCount > 1) {
			return `Question "${q.id}" has ${recommendedCount} options with recommended: true. At most one option per question may be recommended.`
		}

		const optionIds = q.options.map((o) => o.id)
		if (new Set(optionIds).size !== optionIds.length) {
			return `Question "${q.id}" has duplicate option ids.`
		}
		const optionLabels = q.options.map((o) => o.label)
		if (new Set(optionLabels).size !== optionLabels.length) {
			return `Question "${q.id}" has duplicate option labels — labels must be distinct.`
		}
	}

	return null
}

function buildPlanEntry(fermentName: string, params: NormalizedProposeScopingArgs): string {
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
	const divider = pr_dim("╌".repeat(72))
	const planBody = [
		`# Plan: ${fermentName}`,
		"",
		renderWrapped("## Goal", params.goal),
		"",
		renderBullets("## Success criteria", splitListText(params.success_criteria)),
		"",
		renderBullets("## Constraints", params.constraints ?? []),
		"",
		renderBullets("## Assumptions", splitListText(params.assumptions)),
		"",
		"## Phases",
		phaseBlocks.join("\n\n"),
	].join("\n")

	return [pr_bold("Ready to execute?"), "Here is the proposed plan:", divider, planBody, divider].join("\n")
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
	return `The user reviewed your draft and chose these answers (which OVERRIDE your recommendations):\n${bundledAnswerLines.join("\n")}\n\nRe-emit propose_scoping ONCE with updated goal/criteria/constraints/assumptions/phases reflecting these answers. Usually emit \`questions: []\` so the user can review the final plan. You may emit new questions only if these answers reveal a genuinely new, decision-blocking ambiguity; never repeat or rephrase any question answered above. Do NOT ask questions in chat — call the tool directly.`
}

export async function scopeFerment(
	runtime: FermentRuntime,
	params: ScopeArgs,
	{ pi }: LifecycleExecutionContext,
): Promise<ToolResult> {
	const applyAndPersist = createApplyAndPersist(runtime)

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

	// Hard gate: only enforced for ferments scoped interactively (TUI path)
	// in plan mode. Headless, conversational, exec, and auto modes bypass —
	// the LLM is trusted there and one-shot/auto-execution should not stall.
	const fGate = runtime.getStorage().get(params.ferment_id)
	const gateActive = runtime.isScopingInteractive(params.ferment_id) && fGate?.mode === "plan"
	if (gateActive && !runtime.isScopingConfirmed(params.ferment_id)) {
		return toolErr(
			`Cannot scope ferment "${params.ferment_id}" yet — waiting for user confirmation. Present the plan summary to the user and wait for them to confirm before calling scope_ferment.`,
		)
	}
	runtime.consumeScopingGate(params.ferment_id)

	// FSM validation: ensure the scope transition is allowed before applying it.
	const fsmError = validateFsmTransition(fGate, "SCOPE_FERMENT")
	if (fsmError) return toolErr(fsmError)

	const cmd: Command = {
		type: "scope",
		title: params.title,
		goal: params.goal,
		successCriteria: params.success_criteria,
		constraints: params.constraints,
		assumptions: params.assumptions,
		phases: params.phases ?? [],
	}
	const outcome = applyAndPersist(params.ferment_id, cmd)
	if (!outcome.ok) {
		// Special-case: ferment-not-in-status with current "planned"/"running" maps
		// to the user-friendly "use update_scope_field to revise" hint.
		if (outcome.error.code === "FERMENT_NOT_IN_STATUS" && outcome.error.actual !== "draft") {
			return toolErr(`Ferment is already ${outcome.error.actual}. Use update_scope_field to revise individual fields.`)
		}
		return failedToolResult(outcome.error)
	}
	// Discard any stale pending-scope buffer — its phases were either applied
	// here or are no longer relevant (the ferment is now planned).
	runtime.clearPendingScope(params.ferment_id)

	const fresh = outcome.ferment
	const phaseList = fresh.phases.map((p) => `  [${p.id}] ${p.index}. ${p.name} — ${p.goal}`).join("\n") || "(none)"

	// In plan mode, inject the resume nudge exactly once here — at the moment of
	// successful scoping — so the planner is kicked forward without a TUI dropdown.
	if (fresh.mode === "plan") {
		runtime.setActive(fresh)
		injectResumeAutoNudge(pi, runtime)
	}

	return toolOk(
		`Ferment "${fresh.name}" scoped and ready.\nferment_id: ${fresh.id}\nGoal: ${params.goal}\nPhases:\n${phaseList}`,
	)
}

export interface CompleteFermentExecutionContext {
	pi: ExtensionAPI
	ctx?: unknown
}

export async function completeFerment(
	runtime: FermentRuntime,
	params: CompleteFermentArgs,
	{ pi, ctx }: CompleteFermentExecutionContext,
): Promise<ToolResult> {
	const applyAndPersist = createApplyAndPersist(runtime)

	const fSnapshot = runtime.getStorage().get(params.ferment_id)
	if (!fSnapshot) return toolErr("Ferment not found.")

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

	// Gates pass → proceed with completion.
	const completeOutcome = applyAndPersist(params.ferment_id, { type: "complete_ferment" })
	if (!completeOutcome.ok) return failedToolResult(completeOutcome.error)

	// Journey-grade judge: reads per-phase F-gate verdicts from the on-disk
	// review-evidence sidecars, the C-gates the agent just provided, the goal
	// + success criteria, and the total diff. Produces a pessimistic A–F
	// grade with rationale. C-gates already decided ship/refuse — the judge
	// only measures HOW WELL the work was done.
	const ferment = completeOutcome.ferment
	const phaseReviews = readLatestPhaseReviews(ferment.id)
	const totalDiff = ferment.worktree.commit ? gatherPhaseEvidence(ferment.worktree.commit) : undefined
	const journeyResult = await judgeJourneyGrade({
		fermentName: ferment.name,
		goal: ferment.goal ?? "",
		successCriteria: ferment.successCriteria ?? "",
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
		fermentGates: params.gates.map((g) => ({ id: g.id, verdict: g.verdict, rationale: g.rationale })),
		totalDiff: totalDiff
			? { available: totalDiff.available, filesChanged: totalDiff.filesChanged, diffSnippet: totalDiff.diffSnippet }
			: { available: false },
	})

	// Resolve the grade, possibly via a user prompt on judge failure.
	let resolvedGrade: { grade: Grade; rationale: string; unavailable?: boolean }
	if (journeyResult.ok) {
		resolvedGrade = { grade: journeyResult.grade, rationale: journeyResult.rationale }
	} else {
		// Judge failed. In interactive sessions, ask the user whether to ship
		// without a grade or abandon. In one-shot, the judge is also the
		// stand-in for the user — asking is circular — so we abandon directly
		// and leave an artifact for /ferment resume.
		const isOneShot = pi.getFlag?.("ferment-oneshot") === true
		const failureDetail = `${journeyResult.reason}${journeyResult.detail ? `: ${journeyResult.detail}` : ""}`

		if (isOneShot) {
			const abandonOutcome = applyAndPersist(params.ferment_id, {
				type: "abandon",
				reason: `final grade judge unreachable (${failureDetail})`,
			})
			if (abandonOutcome.ok) runtime.setActive(abandonOutcome.ferment)
			return toolErr(
				`complete_ferment refused — final grade judge unreachable in one-shot mode (${failureDetail}).\nFerment abandoned. Restart with a reachable judge or resume interactively.`,
			)
		}

		// Interactive: askUser routes to TUI here. Two options: ship without
		// a grade, or abandon. Failed routing (e.g. no TUI) defaults to
		// abandon — safer when we can't be sure the user saw the prompt.
		const choice = await askUser(
			`Final grade judge unreachable (${failureDetail}). Ship without a grade or abandon?`,
			[
				{
					id: "ship_no_grade",
					label: "Ship without a grade",
					description: "Mark complete; grade will be recorded as unavailable.",
				},
				{ id: "abandon", label: "Abandon ferment", description: "Discard completion; the work stays on disk." },
			],
			{ ferment, pi, ctx: ctx as { ui?: Partial<import("../ui.js").FermentUi> } | undefined, runtime },
		)

		if (choice.failed || choice.choice === "abandon") {
			const reason = choice.failed
				? `judge unreachable and no audience to authorize ungraded ship (${choice.reason})`
				: "judge unreachable; user declined ungraded ship"
			const abandonOutcome = applyAndPersist(params.ferment_id, { type: "abandon", reason })
			if (abandonOutcome.ok) runtime.setActive(abandonOutcome.ferment)
			return toolErr(`complete_ferment refused — ${reason}.`)
		}

		// choice === "ship_no_grade"
		resolvedGrade = {
			grade: "B",
			rationale: `Judge unreachable (${failureDetail}); user authorized ship without a graded review.`,
			unavailable: true,
		}
	}

	// Persist the resolved grade. JudgeGrade requires a `grade` letter and
	// `gradedAt` ISO timestamp; `unavailable` flags ungraded-but-shipped.
	const gradeOutcome = applyAndPersist(params.ferment_id, {
		type: "set_ferment_grade",
		grade: {
			grade: resolvedGrade.grade,
			rationale: resolvedGrade.rationale,
			gradedAt: runtime.nowIso(),
			unavailable: resolvedGrade.unavailable,
		},
	})
	if (!gradeOutcome.ok) return failedToolResult(gradeOutcome.error)

	// Cleanup in-memory state.
	runtime.clearFermentState(params.ferment_id)
	resetReactiveAutoNudgeCount(params.ferment_id)
	runtime.setActive(undefined)

	const fresh = gradeOutcome.ferment
	const failedPhases = fresh.phases.filter((p) => p.status === "failed").length
	const failedNote = failedPhases > 0 ? ` (${failedPhases} phase(s) failed)` : ""
	const gateLines = params.gates.map((g) => `  ${g.id} (${g.verdict}): ${g.rationale}`).join("\n")
	const gradeLabel = resolvedGrade.unavailable ? `${resolvedGrade.grade} (unavailable)` : resolvedGrade.grade

	return toolOk(
		`Ferment "${fresh.name}" complete${failedNote}.\n\nFinal gates:\n${gateLines}\n\nFinal grade: ${gradeLabel} — ${resolvedGrade.rationale}\n\n${params.final_summary ?? ""}`,
	)
}

export function registerLifecycleTools(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	const applyAndPersist = createApplyAndPersist(runtime)
	pi.registerTool({
		name: "create_ferment",
		label: "Create Ferment",
		description: "Create a new ferment at draft status.",
		parameters: CreateFermentParams,
		async execute(_, params) {
			// Creation is special — no existing ferment to transition from.
			// Storage's create() handles uuid generation and worktree capture.
			// LLM-driven, so no interactive prompt; opt-in auto-init only.
			await ensureGitRepo({
				autoInit: pi.getFlag?.("init-git") === true || autoInitFromEnv(),
			})
			const f = runtime.getStorage().create(params.name, params.description)
			setActiveFerment(pi, runtime, f)
			appendRefEntry(pi, f.id)
			const branch = f.worktree.branch ?? "(no git)"
			return toolOk(`Created "${f.name}".  Mode: ${f.mode}  •  Branch: ${branch}  •  Path: ${f.worktree.path}`)
		},
	})

	pi.registerTool({
		name: "propose_scoping",
		label: "Propose Scoping",
		description: `Single combined emission of the full scoping draft after the user's free-form intent. Includes goal, success criteria, constraints, assumptions, phases (3-7), and optional clarifying questions (≤3) with one option \`recommended: true\` per question. Replaces previous draft wholesale.

${renderGateGuidance("scope_ferment")}`,
		parameters: ProposeScopingParams,
		async execute(_, rawParams, _signal, _onUpdate, ctx) {
			const normalized = normalizeProposeScopingParams(rawParams)
			if (!normalized.ok) return normalized.error
			const params = normalized.params

			// 1. Validate P-gates (same as scopeFerment).
			const gateError = validateGatesOrErr(params.gates, {
				turn: "scope_ferment",
				flagPolicy: "block-on-flag",
				renderFlagError: (count, lines) =>
					`Cannot propose scoping — agent self-flagged on ${count} plan gate(s):\n\n${lines}\n\nRevise the plan and call propose_scoping again with passing P-gate verdicts.`,
			})
			if (gateError) return gateError

			// 2. Extra validation: at most one recommended per question, unique ids.
			const questions = params.questions ?? []
			const questionValidationError = validateScopingQuestions(questions)
			if (questionValidationError) return toolErr(questionValidationError)

			// 3. Replace pending buffer wholesale.
			const ferment = runtime.getStorage().get(params.ferment_id)
			if (!ferment) return toolErr(`Ferment "${params.ferment_id}" not found.`)
			if (ferment.status !== "draft") {
				const nextAction = ferment.status === "planned" ? "call activate_phase" : "continue the current ferment action"
				return toolOk(
					`Ferment "${ferment.name}" is already ${ferment.status}; ignore this duplicate propose_scoping call and ${nextAction}.`,
				)
			}

			const pending = runtime.getPendingScope(params.ferment_id)
			if (!pending) {
				// Seed an empty buffer so attachPendingProposal can replace it.
				runtime.setPendingScope(params.ferment_id, { goal: "", successCriteria: "", constraints: [] })
			}

			// Iteration cap: prevent infinite propose_scoping loops.
			const currentIterations = pending?.proposeIterations ?? 0
			const nextIterations = currentIterations + 1
			if (currentIterations >= 3 && questions.length > 0) {
				return toolErr(
					"You've proposed scoping 3 times. Pick the best draft and emit propose_scoping with questions=[] to let the user confirm.",
				)
			}

			runtime.attachPendingProposal(params.ferment_id, {
				title: params.title,
				goal: params.goal,
				successCriteria: params.success_criteria,
				constraints: params.constraints,
				assumptions: params.assumptions,
				phases: params.phases,
				proposeIterations: nextIterations,
			})

			// 4. Build the persistent plan entry. We only emit it at the real
			// decision point: immediately for zero-question drafts, or after the
			// user accepts recommendations. If the user changes answers, the
			// agent re-drafts first so we never show a stale plan as final.
			const planEntry = buildPlanEntry(ferment.name, params)
			const formatPlanEntry = (suffix?: string): string => (suffix ? `${planEntry}\n\n${suffix}` : planEntry)
			const planToolOk = (message: string, options: { includePlan?: boolean; suffix?: string } = {}) =>
				toolOk(options.includePlan ? `${formatPlanEntry(options.suffix)}\n\n${message}` : message)

			// 5. Headless path.
			if (!getPromptUi(ctx)?.select) {
				if (questions.length === 0) {
					const scopeOutcome = confirmPendingScope(
						runtime,
						params.ferment_id,
						params.phases,
						"propose_scoping",
						params.title,
						pi,
					)
					if (!scopeOutcome.ok) return failedToolResult(scopeOutcome.error)
					return planToolOk("Plan saved.", { includePlan: true })
				}
				const recSummary = questions
					.map((q) => {
						const rec = q.options.find((o) => o.recommended) ?? q.options[0]
						return `${q.id}: ${rec.id}`
					})
					.join(", ")
				return toolErr(
					`Cannot ask scoping questions without an interactive UI. Re-emit propose_scoping with those recommendations folded into goal/criteria/constraints/assumptions/phases and questions=[].\nRecommended answers: ${recSummary}`,
				)
			}

			// 6. Zero-questions path: plan is already in chat scrollback above.
			// The dropdown just asks for the decision.
			if (questions.length === 0) {
				const startLabel = "Start execution  ✓"
				const selected = await promptSelect(ctx, `${formatPlanEntry()}\n\nProceed with this plan?`, [
					startLabel,
					"Let me say something",
				])
				if (selected === undefined) {
					return planToolOk("No changes made. Waiting for your next instruction.")
				}
				if (selected === startLabel) {
					const scopeOutcome = confirmPendingScope(
						runtime,
						params.ferment_id,
						params.phases,
						"propose_scoping",
						params.title,
						pi,
					)
					if (!scopeOutcome.ok) return failedToolResult(scopeOutcome.error)
					return planToolOk(
						`Plan saved. Ferment "${scopeOutcome.outcome.ferment.name}" is planned with ${scopeOutcome.outcome.ferment.phases.length} phase(s). Starting execution.`,
						{ includePlan: true },
					)
				}
				// "Let me say something"
				const userText = await promptInput(ctx, "Your direction:", "")
				if (!userText) {
					return planToolOk("No changes made. Waiting for your next instruction.")
				}
				const sayMoreContent = `User said: ${userText}. Re-run propose_scoping incorporating this direction.`
				void pi.sendMessage(
					{ content: sayMoreContent, customType: "ferment_scoping_iteration", display: false },
					{ triggerTurn: true },
				)
				return planToolOk("Got it. Updating the plan with your direction...")
			}

			// 7. Tabbed question form + review loop.
			const runQuestions = async (): Promise<ScopingAnswer[] | "cancelled" | { kind: "dismiss"; qn: number }> => {
				if (!getPromptUi(ctx)?.custom) {
					const answers: ScopingAnswer[] = []
					const customLabel = `✎ ${pr_dim("Custom answer...")}`
					for (let n = 0; n < questions.length; n++) {
						const q = questions[n]
						const labeledOptions = q.options.map((o) => ({
							option: o,
							label: o.recommended === true ? `${o.label}  ★ Recommended` : o.label,
						}))
						const optionLabels = labeledOptions.map((o) => o.label)
						optionLabels.push(customLabel)

						const title = `[Q${n + 1}/${questions.length}] ${q.text}`
						const chosen = await promptSelect(ctx, title, optionLabels)
						if (chosen === undefined) return { kind: "dismiss", qn: n + 1 }
						if (chosen === customLabel) {
							const freeForm = await promptInput(ctx, `[Q${n + 1}/${questions.length}] Your answer for: ${q.text}`, "")
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
						type: "radio",
						label: `Q${index + 1}`,
						prompt: q.text,
						options: q.options.map((o) => ({
							id: o.id,
							label: o.recommended === true ? `${o.label}  ★ Recommended` : o.label,
						})),
						allowOther: true,
					})),
				})
				if (!result) return { kind: "dismiss", qn: 1 }
				if (result.cancelled) return "cancelled"

				const answers: ScopingAnswer[] = []
				for (const q of questions) {
					const answer = result.answers.find((a) => a.id === q.id)
					if (!answer) return { kind: "dismiss", qn: questions.indexOf(q) + 1 }
					if (answer.wasCustom) {
						answers.push({ questionId: q.id, optionId: "custom", label: answer.label, recommended: false })
						continue
					}
					const matched = q.options.find((o) => o.id === answer.value)
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
				const allRecommended = answers.every((a) => a.recommended === true)
				if (getPromptUi(ctx)?.custom) {
					if (allRecommended) {
						const scopeOutcome = confirmPendingScope(
							runtime,
							params.ferment_id,
							params.phases,
							"propose_scoping",
							params.title,
							pi,
						)
						if (!scopeOutcome.ok) return failedToolResult(scopeOutcome.error)
						return planToolOk(
							`Plan saved. Ferment "${scopeOutcome.outcome.ferment.name}" is planned with ${scopeOutcome.outcome.ferment.phases.length} phase(s). Starting execution.`,
							{ includePlan: true, suffix: answersEntry },
						)
					}

					const content = buildScopingIterationMessage(questions, answers)
					void pi.sendMessage(
						{ content, customType: "ferment_scoping_iteration", display: false },
						{ triggerTurn: true },
					)
					return planToolOk(`${answersEntry}\n\nAnswers recorded. Updating the plan with your choices...`)
				}

				const continueLabel = allRecommended ? "Start execution  ✓" : "Update plan  ✓"
				const reviewOptions = [continueLabel, "Restart questions", "Let me say something"]

				const reviewTitle = allRecommended
					? `${formatPlanEntry(answersEntry)}\n\nProceed with this plan?`
					: `${answersEntry}\n\nUpdate the plan with these answers?`
				const reviewChoice = await promptSelect(ctx, reviewTitle, reviewOptions)

				if (reviewChoice === undefined) {
					return planToolOk("Review dismissed. Waiting for your next instruction.")
				}
				if (reviewChoice === "Restart questions") {
					// Loop back to per-question screens.
					continue
				}

				if (reviewChoice === "Let me say something") {
					const userText = await promptInput(ctx, "Your direction:", "")
					if (!userText) {
						return planToolOk(`${answersEntry}\n\nNo changes made. Waiting for your next instruction.`)
					}
					const sayMoreContent = `User said: ${userText}. Re-run propose_scoping incorporating this direction.`
					void pi.sendMessage(
						{ content: sayMoreContent, customType: "ferment_scoping_iteration", display: false },
						{ triggerTurn: true },
					)
					return planToolOk(`${answersEntry}\n\nGot it. Updating the plan with your direction...`)
				}

				// Start immediately only when the user accepted every recommendation.
				if (allRecommended) {
					const scopeOutcome = confirmPendingScope(
						runtime,
						params.ferment_id,
						params.phases,
						"propose_scoping",
						params.title,
						pi,
					)
					if (!scopeOutcome.ok) return failedToolResult(scopeOutcome.error)
					return planToolOk(
						`Plan saved. Ferment "${scopeOutcome.outcome.ferment.name}" is planned with ${scopeOutcome.outcome.ferment.phases.length} phase(s). Starting execution.`,
						{ includePlan: true, suffix: answersEntry },
					)
				}

				const content = buildScopingIterationMessage(questions, answers)
				void pi.sendMessage({ content, customType: "ferment_scoping_iteration", display: false }, { triggerTurn: true })
				return planToolOk(`${answersEntry}\n\nAnswers recorded. Updating the plan with your choices...`)
			}
		},
	})

	pi.registerTool({
		name: "list_ferments",
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
			return toolOk(`Ferments:\n${lines.join("\n")}`)
		},
	})

	pi.registerTool({
		name: "scope_ferment",
		label: "Scope Ferment",
		description: `Save scoping answers and transition ferment from draft to planned. In plan mode, the harness gates this call until the user has confirmed the proposed plan via TUI dropdown. You must produce verdicts for the three plan-scope gates below. A "flag" verdict refuses scoping.

${renderGateGuidance("scope_ferment")}`,
		parameters: ScopeParams,
		async execute(_, params) {
			return scopeFerment(runtime, params, { pi })
		},
	})

	pi.registerTool({
		name: "update_scope_field",
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
			return toolOk(`Field "${params.field}" updated for "${outcome.ferment.name}".`)
		},
	})

	pi.registerTool({
		name: "set_ferment_mode",
		label: "Set Ferment Mode",
		description: "Change the work mode of a ferment.",
		parameters: SetModeParams,
		async execute(_, params) {
			if (!["plan", "exec", "auto"].includes(params.mode)) {
				return toolErr(`Invalid mode: ${params.mode}. Use plan, exec, or auto.`)
			}
			// FSM validation: ensure mode change is allowed
			const f = runtime.getStorage().get(params.ferment_id)
			const fsmError = validateFsmTransition(f, "SET_MODE", { mode: params.mode })
			if (fsmError) return toolErr(fsmError)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "set_mode",
				mode: params.mode as "plan" | "exec" | "auto",
			})
			if (!outcome.ok) return failedToolResult(outcome.error)
			return toolOk(`Mode set to ${params.mode} for "${outcome.ferment.name}".`)
		},
	})

	pi.registerTool({
		name: "complete_ferment",
		label: "Complete Ferment",
		description: `Mark ferment as complete. All phases must be terminal (completed, skipped, or failed). You must produce verdicts for the three ferment-scope gates below. A "flag" verdict refuses ship.

${renderGateGuidance("complete_ferment")}`,
		parameters: CompleteFermentParams,
		async execute(_, params, _signal, _onUpdate, ctx) {
			const result = await completeFerment(runtime, params, { pi, ctx })
			if (!("isError" in result) || result.isError !== true) syncFermentToolScope(pi, runtime.getActive())
			return result
		},
	})

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: `Ask the user a structured question. Use ONLY at genuine decision points the agent cannot resolve from context (e.g. ambiguous requirements, choice between viable approaches, user-only authorization).

Behavior depends on session mode:
  - Interactive (with TUI): the user answers in a structured TUI. Returns { choice | choices | text | answers, answered_by: "user" }.
  - One-shot (no human attached): an Opus judge stands in for the user. Returns { choice | choices | text | answers, answered_by: "judge", rationale }.

Hard contract: in one-shot mode, if the judge is unreachable (no API key, timeout, unparseable response) the ferment is ABANDONED — there is no fallback. False-pass is the worst outcome.

The agent should:
  1. Frame the question concretely. The user/judge sees only the question plus options/context in this call.
  2. Prefer questions[] for the full TUI: radio, checkbox, text; allowOther enables a custom free-text option.
  3. Use response_type="single" | "multi" | "text" only as a compatibility shorthand for one question.
  4. For radio/checkbox, provide stable snake-case option ids and short labels.
  5. Include "pause" or "abandon" as an explicit option when one is appropriate — the judge prefers these when uncertain.
  6. Act on the returned \`answers\`, \`choice\`, \`choices\`, or \`text\` field.

TUI controls for questions[]:
  - Tab / Shift+Tab moves between questions
  - Up/Down navigates options
  - Space toggles checkboxes
  - Enter selects radio / submits text / advances
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
			const response =
				params.questions && params.questions.length > 0
					? await askUserForm(params.title ?? params.question, params.description, params.questions, askContext)
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
