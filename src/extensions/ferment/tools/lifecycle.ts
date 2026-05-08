/**
 * Ferment lifecycle tools: create, list, scope, update fields, set mode, complete.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Ferment, FermentWorkMode, Phase, Step } from "../../../ferment/types.js"
import { computeFermentGrade, judgePlan } from "../judge.js"
import { maybeInjectAutoNudge } from "../nudge.js"
import { appendRefEntry } from "../nudge.js"
import {
	clearFermentState,
	consumeScopingGate,
	getActiveId,
	getStorage,
	isScopingConfirmed,
	isScopingInteractive,
	setActive,
} from "../state.js"
import { toolErr } from "../tool-helpers.js"
import {
	CompleteFermentParams,
	CreateFermentParams,
	ListParams,
	ScopeParams,
	SetModeParams,
	UpdateScopeFieldParams,
} from "../tool-schemas.js"

export function registerLifecycleTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "create_ferment",
		label: "Create Ferment",
		description: "Create a new ferment at draft status.",
		parameters: CreateFermentParams,
		async execute(_, params) {
			const f = getStorage().create(params.name, params.description)
			setActive(f)
			appendRefEntry(pi, f.id)
			const wt = f.worktree
			const branch = wt.branch ?? "(no git)"
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Created "${f.name}".  Mode: ${f.mode}  •  Branch: ${branch}  •  Path: ${wt.path}`,
					},
				],
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
			const items = getStorage().list()
			// Normalize filter: "active" is not a status — "running" is the running state
			const filterValue = params.filter === "active" ? "running" : params.filter
			const filtered = filterValue ? items.filter((f) => f.status === filterValue) : items
			if (filtered.length === 0) {
				const msg = filterValue ? `No ferments with status "${filterValue}".` : "No ferments."
				return { details: undefined, content: [{ type: "text", text: msg }] }
			}
			const activeId = getActiveId()
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Ferments:\n${filtered
							.map((f) => {
								const active = f.id === activeId ? " ← active" : ""
								return `- ${f.id} │ ${f.name} [${f.status}] — ${f.phaseCount} phases${active}`
							})
							.join("\n")}`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "scope_ferment",
		label: "Scope Ferment",
		description:
			"Save scoping answers and transition ferment from draft to planned. In plan mode, the harness gates this call until the user has confirmed the proposed plan via TUI dropdown.",
		parameters: ScopeParams,
		async execute(_, params) {
			// Hard gate: only enforced for ferments scoped interactively (TUI path)
			// in plan mode. Headless, conversational, exec, and auto modes bypass —
			// the LLM is trusted there and one-shot/auto-execution should not stall.
			const fGate = getStorage().get(params.ferment_id)
			const gateActive = isScopingInteractive(params.ferment_id) && fGate?.mode === "plan"
			if (gateActive && !isScopingConfirmed(params.ferment_id)) {
				return toolErr(
					`Cannot scope ferment "${params.ferment_id}" yet — waiting for user confirmation. Present the plan summary to the user and wait for them to confirm before calling scope_ferment.`,
				)
			}
			consumeScopingGate(params.ferment_id)

			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr(`Ferment not found: ${params.ferment_id}`)

			// Cannot re-scope if already past draft
			if (f.status !== "draft") {
				return toolErr(`Ferment is already ${f.status}. Use update_scope_field to revise individual fields.`)
			}

			if (params.title) {
				s.rename(f.id, params.title)
			}

			// Set each scoping field atomically
			s.setScopingGoal(f.id, params.goal)

			if (params.success_criteria) {
				s.setScopingCriteria(f.id, params.success_criteria)
			}

			if (params.constraints && params.constraints.length > 0) {
				s.setScopingConstraints(f.id, params.constraints)
			}

			let phases: Phase[] = []
			if (params.phases && params.phases.length > 0) {
				phases = params.phases.map((p, i) => {
					const steps: Step[] = (p.steps ?? []).map((st, si) => ({
						id: `step-${si + 1}`,
						index: si + 1,
						description: st.description,
						status: "pending" as const,
						verification: st.verify ? { command: st.verify, retries: 2, retryDelayMs: 1000 } : undefined,
					}))
					return {
						id: `phase-${i + 1}`,
						index: i + 1,
						name: p.name,
						goal: p.goal,
						description: p.description ?? "",
						constraints: p.constraints,
						budget: p.budget,
						parallel: p.parallel_group !== undefined,
						groupIndex: p.parallel_group,
						status: "planned" as const,
						steps,
					}
				})
				s.setScopingPhases(f.id, phases)
			}

			// Transition to planned only after scoping is saved
			s.updateStatus(f.id, "planned")
			const fresh = s.get(f.id)
			if (fresh) setActive(fresh)

			// ── Plan review: judge checks phases before execution starts ─────────
			const f2 = s.get(f.id)
			const phaseList = f2?.phases.map((p) => `  [${p.id}] ${p.index}. ${p.name} — ${p.goal}`).join("\n") ?? "(none)"

			const planReview = await judgePlan(
				f2?.name ?? f.name,
				params.goal,
				params.success_criteria ?? "",
				(params.constraints ?? []).join(", "),
				phaseList,
			)

			// Do NOT call onPhaseCompleted here — ferment just became "planned",
			// not executing. The engine's activate_phase nudge handles the next step.
			maybeInjectAutoNudge(pi)

			const reviewNote =
				planReview.verdict === "approve"
					? `\n\nPlan review: ✓ approved (confidence: ${planReview.confidence}%)`
					: `\n\nPlan review: ⚠ revision suggested (confidence: ${planReview.confidence}%)\n${planReview.suggestions.map((s) => `  • ${s}`).join("\n")}\n\nRevise the phases if needed, then proceed with activate_phase.`

			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Ferment "${f2?.name ?? f.name}" scoped and ready.\nferment_id: ${f2?.id ?? f.id}\nGoal: ${params.goal}\nPhases:\n${phaseList}${reviewNote}`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "update_scope_field",
		label: "Update Scope Field",
		description: "Revise a single scoping field (goal, criteria, constraints) on an already-planned ferment.",
		parameters: UpdateScopeFieldParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")

			let updated: Ferment | undefined

			if (params.field === "goal") {
				updated = s.setScopingGoal(f.id, params.value)
			} else if (params.field === "criteria") {
				updated = s.setScopingCriteria(f.id, params.value)
			} else if (params.field === "constraints") {
				const parsed = params.value
					.split(",")
					.map((c) => c.trim())
					.filter(Boolean)
				updated = s.setScopingConstraints(f.id, parsed)
			} else {
				return toolErr(`Unknown field: ${params.field}. Use goal, criteria, or constraints.`)
			}

			if (updated) setActive(updated)
			return {
				details: undefined,
				content: [{ type: "text", text: `Field "${params.field}" updated for "${f.name}".` }],
			}
		},
	})

	pi.registerTool({
		name: "set_ferment_mode",
		label: "Set Ferment Mode",
		description: "Change the work mode of a ferment.",
		parameters: SetModeParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			if (!["plan", "exec", "auto"].includes(params.mode)) {
				return toolErr(`Invalid mode: ${params.mode}. Use plan, exec, or auto.`)
			}
			const updated = s.updateMode(f.id, params.mode as FermentWorkMode)
			if (updated) setActive(updated)
			return { details: undefined, content: [{ type: "text", text: `Mode set to ${params.mode} for "${f.name}".` }] }
		},
	})

	pi.registerTool({
		name: "complete_ferment",
		label: "Complete Ferment",
		description:
			"Mark ferment as complete. All phases must be terminal (completed, skipped, or failed). Judge computes overall grade.",
		parameters: CompleteFermentParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const nonTerminal = f.phases.some((p) => p.status === "planned" || p.status === "active")
			if (nonTerminal) {
				const blocking = f.phases.filter((p) => p.status === "planned" || p.status === "active")
				return toolErr(
					`Cannot complete: ${blocking.length} phase(s) still active or planned: ${blocking.map((p) => `"${p.name}"`).join(", ")}`,
				)
			}

			s.updateStatus(f.id, "complete")
			clearFermentState(f.id)

			// ── Compute overall ferment grade from phase grades ──────────────────
			const fresh = s.get(f.id) ?? f
			const fermentGrade = computeFermentGrade(fresh.phases)
			const graded = s.setFermentGrade(fresh.id, fermentGrade)
			if (graded) setActive(graded)

			const failedPhases = fresh.phases.filter((p) => p.status === "failed").length
			const failedNote = failedPhases > 0 ? ` (${failedPhases} phase(s) failed)` : ""
			const phaseGradeSummary = fresh.phases
				.filter((p) => p.grade)
				.map((p) => `  ${p.index}. ${p.name}: ${p.grade?.grade}`)
				.join("\n")
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Ferment "${fresh.name}" complete${failedNote}.\n\nOverall Grade: ${fermentGrade.grade} — ${fermentGrade.rationale}\n\nPhase grades:\n${phaseGradeSummary || "  (none graded)"}\n\n${params.final_summary ?? ""}`,
					},
				],
			}
		},
	})
}
