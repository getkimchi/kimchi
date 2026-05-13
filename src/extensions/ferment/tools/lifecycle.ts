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
import type { Command } from "../../../ferment/state-machine.js"
import type { Grade } from "../../../ferment/types.js"
import { askUser } from "../ask-user.js"
import { validateFsmTransitionWithFerment } from "../fsm-adapter.js"
import { renderGateGuidance } from "../gate-registry.js"
import { validateGatesOrErr } from "../gate-validation.js"
import { autoInitFromEnv, ensureGitRepo } from "../git-init.js"
import { judgeJourneyGrade } from "../judge.js"
import { appendRefEntry, resetReactiveAutoNudgeCount } from "../nudge.js"
import { gatherPhaseEvidence } from "../phase-evidence.js"
import { readLatestPhaseReviews } from "../review-evidence.js"
import { type FermentRuntime, defaultFermentRuntime } from "../runtime.js"
import { confirmPendingScope } from "../scoping-confirmation.js"
import { createApplyAndPersist, failedToolResult, toolErr, toolOk } from "../tool-helpers.js"
import {
	AskUserParams,
	CompleteFermentParams,
	CreateFermentParams,
	ListParams,
	ProposePhasesParams,
	ScopeParams,
	SetModeParams,
	UpdateScopeFieldParams,
} from "../tool-schemas.js"
import { setActiveFerment, syncFermentToolScope } from "../tool-scope.js"

type ScopeArgs = Static<typeof ScopeParams>
type CompleteFermentArgs = Static<typeof CompleteFermentParams>
type ToolResult = ReturnType<typeof toolOk> | ReturnType<typeof toolErr>

export interface LifecycleExecutionContext {
	pi: ExtensionAPI
}

const validateFsmTransition = (
	f: Parameters<typeof validateFsmTransitionWithFerment>[0],
	event: Parameters<typeof validateFsmTransitionWithFerment>[1],
	params?: Parameters<typeof validateFsmTransitionWithFerment>[2],
): string | null => validateFsmTransitionWithFerment(f, event, params).error ?? null

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

	// FSM validation: ensure scope transition is allowed. The previous
	// `hasPhases` guard on SCOPE_FERMENT was wrong (scope creates phases) and
	// has been removed; this call now always runs and the duct-tape "skip
	// for status === draft" workaround is gone.
	const fsmError = validateFsmTransition(fGate, "SCOPE_FERMENT")
	if (fsmError) return toolErr(fsmError)

	const cmd: Command = {
		type: "scope",
		title: params.title,
		goal: params.goal,
		successCriteria: params.success_criteria,
		constraints: params.constraints,
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
	if (outcome.ferment.mode === "plan") runtime.markAfterScopeContinuation(params.ferment_id)

	const fresh = outcome.ferment
	const phaseList = fresh.phases.map((p) => `  [${p.id}] ${p.index}. ${p.name} — ${p.goal}`).join("\n") || "(none)"

	// Auto-nudge handling moved to main's reactive turn-end model — see nudge.ts.
	// Plan-quality is now enforced via P-gates above; no LLM plan review.

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
		name: "propose_phases",
		label: "Propose Phases",
		description: `Stash a structured plan proposal for the user to review. Call this DURING interactive scoping, AFTER presenting the plan to the user as a numbered list. The tool opens the confirmation dropdown and the host applies the proposal automatically when the user confirms — you should NOT ask an additional 'Does this plan look right?' question or call scope_ferment yourself in this flow. You must produce verdicts for the three plan-scope gates below. A "flag" verdict refuses the proposal.

${renderGateGuidance("scope_ferment")}`,
		parameters: ProposePhasesParams,
		async execute(_, params, _signal, _onUpdate, ctx) {
			// The pending-scope buffer must already exist (set by runScopingFlow's
			// TUI step). If it doesn't, the LLM is calling propose_phases outside
			// the interactive flow — reject with a clear message.
			const pending = runtime.getPendingScope(params.ferment_id)
			if (!pending) {
				return toolErr(
					`No pending scope for ferment "${params.ferment_id}". propose_phases is only valid during the interactive scoping flow started by /ferment add. For headless or one-shot scoping, call scope_ferment directly with all fields.`,
				)
			}
			if (!params.phases || params.phases.length === 0) {
				return toolErr("propose_phases requires at least one phase. Provide 3–7 ordered phases with steps.")
			}

			// Plan-scope gates are required here too — the agent must answer
			// P1/P2/P3 about the proposal before it's even buffered.
			const gateError = validateGatesOrErr(params.gates, {
				turn: "scope_ferment",
				flagPolicy: "block-on-flag",
				renderFlagError: (count, lines) =>
					`Cannot propose phases — agent self-flagged on ${count} plan gate(s):\n\n${lines}\n\nRevise the proposal and call propose_phases again.`,
			})
			if (gateError) return gateError

			runtime.attachPendingPhases(params.ferment_id, params.phases)

			const fermentForAsk = runtime.getStorage().get(params.ferment_id)
			if (!fermentForAsk) return toolErr("Ferment not found.")

			const phaseLines = params.phases.map((p, i) => `${i + 1}. ${p.name} — ${p.goal}`).join("\n")
			const response = await askUser(
				`Proposed plan:\n\n${phaseLines}\n\nDoes this plan look right?`,
				[
					{ id: "confirm", label: "Yes, this looks right" },
					{ id: "revise", label: "No, revise" },
					{ id: "say_more", label: "Let me say something else" },
				],
				{ ferment: fermentForAsk, pi, ctx, runtime },
			)

			if (response.failed) {
				// No audience reachable. Leave the proposal buffered for a later
				// confirmation attempt; surface what happened to the agent.
				return toolOk(
					`Proposal received: ${params.phases.length} phase(s) buffered. The user will see your numbered list and confirm via dropdown — do not call scope_ferment yourself.`,
				)
			}

			if (response.choice === "revise") {
				return toolOk(
					"Proposal buffered, but the user requested revisions. Revise the plan and call propose_phases again.",
				)
			}
			if (response.choice === "say_more") {
				// Free-form input is TUI-only; in one-shot mode the judge can't be
				// asked for arbitrary text. Use ctx.ui.input directly when present.
				const custom = ctx?.ui?.input ? await ctx.ui.input("Your message:", "") : undefined
				if (custom) return toolOk(`Proposal buffered. User direction: ${custom}`)
				return toolOk("Proposal buffered. Awaiting the user's custom direction.")
			}

			// choice === "confirm"
			const scopeOutcome = confirmPendingScope(runtime, params.ferment_id, params.phases, "propose_phases")
			if (!scopeOutcome.ok) return failedToolResult(scopeOutcome.error)
			return toolOk(
				`Proposal confirmed and saved. Ferment "${scopeOutcome.outcome.ferment.name}" is now planned with ${scopeOutcome.outcome.ferment.phases.length} phase(s).`,
			)
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
		description: "Revise a single scoping field (goal, criteria, constraints) on an already-planned ferment.",
		parameters: UpdateScopeFieldParams,
		async execute(_, params) {
			if (params.field !== "goal" && params.field !== "criteria" && params.field !== "constraints") {
				return toolErr(`Unknown field: ${params.field}. Use goal, criteria, or constraints.`)
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
		description: `Ask the user a structured question with a small set of options. Use ONLY at genuine decision points the agent cannot resolve from context (e.g. ambiguous requirements, choice between two viable approaches, user-only authorization).

Behavior depends on session mode:
  - Interactive (with TUI): the user picks an option. Returns { choice, answered_by: "user" }.
  - One-shot (no human attached): an Opus judge stands in for the user. Returns { choice, answered_by: "judge", rationale }.

Hard contract: in one-shot mode, if the judge is unreachable (no API key, timeout, unparseable response) the ferment is ABANDONED — there is no fallback. False-pass is the worst outcome.

The agent should:
  1. Frame the question concretely. The user/judge sees only the question + options.
  2. Provide 2–5 options with stable snake-case ids and short labels.
  3. Include "pause" or "abandon" as an explicit option when one is appropriate — the judge prefers these when uncertain.
  4. Act on the returned \`choice\` field.

Returns: { choice, answered_by, rationale? } on success, or a tool error if no audience can be reached.`,
		parameters: AskUserParams,
		async execute(_, params, _signal, _onUpdate, ctx) {
			const applyAndPersist = createApplyAndPersist(runtime)
			const ferment = runtime.getStorage().get(params.ferment_id)
			if (!ferment) return toolErr("Ferment not found.")

			const response = await askUser(params.question, params.options, {
				ferment,
				pi,
				ctx: ctx as { ui?: Partial<import("../ui.js").FermentUi> } | undefined,
				runtime,
			})

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
			return toolOk(
				`Answer received.\nChoice: ${response.choice}\nAnswered by: ${response.answered_by}${rationaleLine}`,
			)
		},
	})
}
