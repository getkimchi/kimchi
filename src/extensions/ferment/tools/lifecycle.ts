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
import { validateFsmTransitionWithFerment } from "../fsm-adapter.js"
import {
	GateCoverageError,
	assertGateCoverage,
	flaggedVerdicts,
	hasBlockingFlag,
	renderGateGuidance,
	validateGateVerdict,
} from "../gate-registry.js"
import { autoInitFromEnv, ensureGitRepo } from "../git-init.js"
import { appendRefEntry, resetReactiveAutoNudgeCount } from "../nudge.js"
import { type FermentRuntime, defaultFermentRuntime } from "../runtime.js"
import { confirmPendingScope } from "../scoping-confirmation.js"
import { createApplyAndPersist, failedToolResult, toolErr, toolOk } from "../tool-helpers.js"
import {
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

// The gate-registry migration removed every external service this handler
// used to depend on (judgePlan / computeFermentGrade / maybeInjectAutoNudge).
// The empty shape stays as a DI seam so tests can inject mocks if future
// per-handler dependencies show up; today there are none.
// biome-ignore lint/complexity/noBannedTypes: intentional empty DI seam
export type LifecycleHandlerServices = {}

export interface LifecycleExecutionContext {
	pi: ExtensionAPI
}

export const defaultLifecycleHandlerServices: LifecycleHandlerServices = {}

const validateFsmTransition = (
	f: Parameters<typeof validateFsmTransitionWithFerment>[0],
	event: Parameters<typeof validateFsmTransitionWithFerment>[1],
	params?: Parameters<typeof validateFsmTransitionWithFerment>[2],
): string | null => validateFsmTransitionWithFerment(f, event, params).error ?? null

export async function scopeFerment(
	runtime: FermentRuntime,
	params: ScopeArgs,
	{ pi }: LifecycleExecutionContext,
	services: LifecycleHandlerServices = defaultLifecycleHandlerServices,
): Promise<ToolResult> {
	const applyAndPersist = createApplyAndPersist(runtime)

	// Plan-scope gate validation runs BEFORE any state mutation. The agent
	// must declare verifiable success signals (P1), composition (P2), and
	// the ferment-completion checklist (P3) before scoping is accepted.
	try {
		assertGateCoverage(params.gates, "scope_ferment")
	} catch (err) {
		if (err instanceof GateCoverageError) return toolErr(err.message)
		throw err
	}
	for (const v of params.gates) {
		const shapeError = validateGateVerdict(v)
		if (shapeError) return toolErr(shapeError)
	}
	if (hasBlockingFlag(params.gates)) {
		const flagLines = flaggedVerdicts(params.gates)
			.map((v) => `  ⛔ Gate ${v.id}: ${v.rationale}\n     evidence: ${v.evidence}`)
			.join("\n")
		return toolErr(
			`Cannot scope ferment — agent self-flagged on ${flaggedVerdicts(params.gates).length} plan gate(s):\n\n${flagLines}\n\nRevise the plan (e.g. give each phase a verifiable success signal, declare a concrete checklist for complete_ferment) and call scope_ferment again with passing P-gate verdicts.`,
		)
	}

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

export async function completeFerment(
	runtime: FermentRuntime,
	params: CompleteFermentArgs,
	_services: LifecycleHandlerServices = defaultLifecycleHandlerServices,
): Promise<ToolResult> {
	const applyAndPersist = createApplyAndPersist(runtime)

	const fSnapshot = runtime.getStorage().get(params.ferment_id)
	if (!fSnapshot) return toolErr("Ferment not found.")

	// Ferment-scope gate validation runs BEFORE any state mutation. The agent
	// must answer C1 (success criteria satisfied), C2 (no unresolved F3
	// deferrals), C3 (real verification ran the artifact) before ship is
	// allowed. A flag on any gate refuses ship.
	try {
		assertGateCoverage(params.gates, "complete_ferment")
	} catch (err) {
		if (err instanceof GateCoverageError) return toolErr(err.message)
		throw err
	}
	for (const v of params.gates) {
		const shapeError = validateGateVerdict(v)
		if (shapeError) return toolErr(shapeError)
	}
	if (hasBlockingFlag(params.gates)) {
		const flagLines = flaggedVerdicts(params.gates)
			.map((v) => `  ⛔ Gate ${v.id}: ${v.rationale}\n     evidence: ${v.evidence}`)
			.join("\n")
		return toolErr(
			`complete_ferment refused — agent self-flagged on ${flaggedVerdicts(params.gates).length} ferment gate(s):\n\n${flagLines}\n\nAddress the concern(s) and call complete_ferment again with passing C-gate verdicts.`,
		)
	}

	// Gates pass → proceed with completion.
	const completeOutcome = applyAndPersist(params.ferment_id, { type: "complete_ferment" })
	if (!completeOutcome.ok) return failedToolResult(completeOutcome.error)

	// Persist a deterministic ship-grade. All C-gates passed (any flag would
	// have refused above), so the grade is "A". The rationale carries the
	// agent's C1 evidence so the audit trail is concrete.
	const c1 = params.gates.find((g) => g.id === "C1")
	const shipGrade = {
		grade: "A" as const,
		rationale: c1?.rationale ?? "All ferment-scope gates passed.",
		gradedAt: runtime.nowIso(),
	}
	const gradeOutcome = applyAndPersist(params.ferment_id, { type: "set_ferment_grade", grade: shipGrade })
	if (!gradeOutcome.ok) return failedToolResult(gradeOutcome.error)

	// Cleanup in-memory state.
	runtime.clearFermentState(params.ferment_id)
	resetReactiveAutoNudgeCount(params.ferment_id)
	runtime.setActive(undefined)

	const fresh = gradeOutcome.ferment
	const failedPhases = fresh.phases.filter((p) => p.status === "failed").length
	const failedNote = failedPhases > 0 ? ` (${failedPhases} phase(s) failed)` : ""
	const phaseGradeSummary = fresh.phases
		.filter((p) => p.grade)
		.map((p) => `  ${p.index}. ${p.name}: ${p.grade?.grade}`)
		.join("\n")
	const gateLines = params.gates.map((g) => `  ${g.id} (${g.verdict}): ${g.rationale}`).join("\n")

	return toolOk(
		`Ferment "${fresh.name}" complete${failedNote}.\n\nFinal gates:\n${gateLines}\n\nPhase grades:\n${phaseGradeSummary || "  (none graded)"}\n\n${params.final_summary ?? ""}`,
	)
}

export function registerLifecycleTools(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	const applyAndPersist = createApplyAndPersist(runtime)
	const lifecycleServices: LifecycleHandlerServices = defaultLifecycleHandlerServices
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
			try {
				assertGateCoverage(params.gates, "scope_ferment")
			} catch (err) {
				if (err instanceof GateCoverageError) return toolErr(err.message)
				throw err
			}
			for (const v of params.gates) {
				const shapeError = validateGateVerdict(v)
				if (shapeError) return toolErr(shapeError)
			}
			if (hasBlockingFlag(params.gates)) {
				const flagLines = flaggedVerdicts(params.gates)
					.map((v) => `  ⛔ Gate ${v.id}: ${v.rationale}\n     evidence: ${v.evidence}`)
					.join("\n")
				return toolErr(
					`Cannot propose phases — agent self-flagged on ${flaggedVerdicts(params.gates).length} plan gate(s):\n\n${flagLines}\n\nRevise the proposal and call propose_phases again.`,
				)
			}

			runtime.attachPendingPhases(params.ferment_id, params.phases)

			if (ctx?.ui?.select) {
				const phaseLines = params.phases.map((p, i) => `${i + 1}. ${p.name} — ${p.goal}`).join("\n")
				const choice = await ctx.ui.select(`Proposed plan:\n\n${phaseLines}\n\nDoes this plan look right?`, [
					"Yes, this looks right",
					"No, revise",
					"Let me say something else",
				])
				runtime.markHumanInput()

				if (!choice) {
					return toolOk(
						`Proposal received: ${params.phases.length} phase(s) buffered. Awaiting user confirmation before scoping.`,
					)
				}
				if (choice === "No, revise") {
					return toolOk(
						"Proposal buffered, but the user requested revisions. Revise the plan and call propose_phases again.",
					)
				}
				if (choice === "Let me say something else") {
					const custom = ctx.ui.input ? await ctx.ui.input("Your message:", "") : undefined
					if (custom) return toolOk(`Proposal buffered. User direction: ${custom}`)
					return toolOk("Proposal buffered. Awaiting the user's custom direction.")
				}

				const scopeOutcome = confirmPendingScope(runtime, params.ferment_id, params.phases, "propose_phases")
				if (!scopeOutcome.ok) return failedToolResult(scopeOutcome.error)
				return toolOk(
					`Proposal confirmed and saved. Ferment "${scopeOutcome.outcome.ferment.name}" is now planned with ${scopeOutcome.outcome.ferment.phases.length} phase(s).`,
				)
			}

			return toolOk(
				`Proposal received: ${params.phases.length} phase(s) buffered. The user will see your numbered list and confirm via dropdown — do not call scope_ferment yourself.`,
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
			return scopeFerment(runtime, params, { pi }, lifecycleServices)
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
		async execute(_, params) {
			const result = await completeFerment(runtime, params, lifecycleServices)
			if (!("isError" in result) || result.isError !== true) syncFermentToolScope(pi, runtime.getActive())
			return result
		},
	})
}
