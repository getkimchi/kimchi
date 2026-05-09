/**
 * Phase tools: activate_phase, refine_phase, complete_phase, skip_phase, fail_phase.
 *
 * complete_phase is the most complex — in plan mode it surfaces a TUI dropdown
 * with a structured phase review and routes the response back to the planner
 * via `pi.sendUserMessage(..., { deliverAs: "followUp" })`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { findFirstPlannedPhase } from "../../../ferment/engine.js"
import { truncateLabel } from "../colors.js"
import { formatDecisionsAndMemories, formatScopingContext } from "../format.js"
import { validateFsmTransitionWithFerment } from "../fsm-adapter.js"
import { judgeGradePhase, judgeSuggestCorrectiveStep } from "../judge.js"
import { isPlanMode } from "../modes.js"
import { onPhaseCompleted } from "../nudge.js"
import { captureGitHead, gatherPhaseEvidence } from "../phase-evidence.js"
import {
	captureJudgeContext,
	getPhaseStartRef,
	getStorage,
	markHumanInput,
	setActive,
	setCorrectiveStep,
	setPhaseStartRef,
} from "../state.js"
import { applyAndPersist, failedToolResult, resolvePhase, toolErr, toolOk } from "../tool-helpers.js"
import { ActivateParams, CompletePhaseParams, FailPhaseParams, RefineParams, SkipPhaseParams } from "../tool-schemas.js"

const validateFsmTransition = (
	f: Parameters<typeof validateFsmTransitionWithFerment>[0],
	event: Parameters<typeof validateFsmTransitionWithFerment>[1],
	params?: Parameters<typeof validateFsmTransitionWithFerment>[2],
): string | null => validateFsmTransitionWithFerment(f, event, params).error ?? null

export function registerPhaseTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "activate_phase",
		label: "Activate Phase",
		description: "Start a planned phase.",
		parameters: ActivateParams,
		async execute(_, params) {
			// Resolution is a host concern (fuzzy lookup) — find the phase first,
			// then dispatch to the right state-machine command.
			const f = getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")

			let target = params.phase_id ? f.phases.find((p) => p.id === params.phase_id) : undefined
			if (!target && params.phase_id) {
				const name = params.phase_id.toLowerCase()
				target = f.phases.find((p) => p.name.toLowerCase().includes(name))
			}
			if (!target) target = findFirstPlannedPhase(f)
			if (!target) return toolErr("No planned phases to activate.")

			// FSM validation: ensure phase activation is allowed
			const fsmError = validateFsmTransition(f, "ACTIVATE_PHASE", { phaseId: target.id })
			if (fsmError) return toolErr(fsmError)

			// Detect parallel group — activate all siblings at once
			if (target.groupIndex !== undefined) {
				const outcome = applyAndPersist(params.ferment_id, {
					type: "activate_phase_group",
					groupIndex: target.groupIndex,
				})
				if (!outcome.ok) return failedToolResult(outcome.error)

				// Capture git HEAD per phase so the grader can diff each one independently.
				const headRef = captureGitHead()
				if (headRef) {
					for (const p of outcome.ferment.phases) {
						if (p.groupIndex === target.groupIndex && p.status === "active") {
							setPhaseStartRef(params.ferment_id, p.id, headRef)
						}
					}
				}

				const fresh = outcome.ferment
				const groupPhases = fresh.phases.filter((p) => p.groupIndex === target.groupIndex && p.status === "active")
				const phaseLines = groupPhases
					.map((gp) => {
						const stepList =
							gp.steps.length > 0
								? `\n    Steps:\n${gp.steps.map((st) => `      ${st.index}. [${st.id}] ${st.description}`).join("\n")}`
								: "\n    No steps yet — call refine_phase to populate them."
						return `  ∥ [${gp.id}] ${gp.index}. "${gp.name}"${stepList}`
					})
					.join("\n")
				const dm = formatDecisionsAndMemories(fresh)
				const dmSection = dm ? `\n\n${dm}` : ""
				const sc = formatScopingContext(fresh)
				const scSection = sc ? `\n\n${sc}` : ""
				return toolOk(
					`Parallel group ${target.groupIndex} activated (${groupPhases.length} phases running concurrently).\nferment_id: ${fresh.id}\nparallel_group: ${target.groupIndex}\nphase_ids: ${groupPhases.map((p) => p.id).join(", ")}\n\n${phaseLines}\n\nRun all parallel phases concurrently: call refine_phase + start_step for each phase simultaneously.${scSection}${dmSection}`,
				)
			}

			const outcome = applyAndPersist(params.ferment_id, { type: "activate_phase", phaseId: target.id })
			if (!outcome.ok) return failedToolResult(outcome.error)

			// Capture git HEAD so the phase grader can diff against it later.
			const headRef = captureGitHead()
			if (headRef) setPhaseStartRef(params.ferment_id, target.id, headRef)

			const fresh = outcome.ferment
			const activated = fresh.phases.find((p) => p.id === target.id)
			const stepList =
				activated && activated.steps.length > 0
					? `\nSteps:\n${activated.steps.map((st) => `  ${st.index}. [${st.id}] ${st.description}`).join("\n")}`
					: "\nNo steps yet — call refine_phase to populate them."
			const dm = formatDecisionsAndMemories(fresh)
			const dmSection = dm ? `\n\n${dm}` : ""
			const sc = formatScopingContext(fresh)
			const scSection = sc ? `\n\n${sc}` : ""
			return toolOk(
				`Phase "${target.name}" activated.\nferment_id: ${fresh.id}\nphase_id: ${target.id}${stepList}${scSection}${dmSection}`,
			)
		},
	})

	pi.registerTool({
		name: "refine_phase",
		label: "Refine Phase",
		description: "Add steps to an active phase. Overwrites existing. Use the phase_id returned by activate_phase.",
		parameters: RefineParams,
		async execute(_, params) {
			// Phase resolution: exact id → name substring → active phase fallback.
			const f = getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			let phase = f.phases.find((p) => p.id === params.phase_id)
			if (!phase) {
				const needle = params.phase_id.toLowerCase()
				phase = f.phases.find((p) => p.name.toLowerCase().includes(needle))
			}
			if (!phase) phase = f.phases.find((p) => p.status === "active")
			if (!phase) {
				return toolErr(
					`Phase not found. Active phases: ${
						f.phases
							.filter((p) => p.status === "active")
							.map((p) => `${p.id} (${p.name})`)
							.join(", ") || "none"
					}`,
				)
			}

			// FSM validation: refine_phase is only valid in PHASE_ACTIVE state
			const fsmError = validateFsmTransition(f, "REFINE_PHASE", { phaseId: phase.id })
			if (fsmError) return toolErr(fsmError)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "refine_phase",
				phaseId: phase.id,
				steps: params.steps,
			})
			if (!outcome.ok) {
				// Rewrite phase-not-active for the LLM-friendly form expected today.
				if (outcome.error.code === "PHASE_NOT_IN_STATUS") {
					return toolErr(`Phase must be active. Current: ${outcome.error.actual}`)
				}
				return failedToolResult(outcome.error)
			}

			const refined = outcome.ferment.phases.find((p) => p.id === phase.id)
			const stepList = refined?.steps.map((st, i) => `  ${i + 1}. [step-${i + 1}] ${st.description}`).join("\n") ?? ""
			return toolOk(
				`"${phase.name}" refined with ${refined?.steps.length ?? 0} step(s).\nferment_id: ${outcome.ferment.id}\nphase_id: ${phase.id}\n${stepList}\nCall start_step with step_id to begin.`,
			)
		},
	})

	pi.registerTool({
		name: "complete_phase",
		label: "Complete Phase",
		description: "Mark phase as completed. Judge grades the phase based on step results.",
		parameters: CompletePhaseParams,
		async execute(_, params, _signal, _onUpdate, ctx) {
			captureJudgeContext(ctx?.model, ctx?.modelRegistry)

			// Step 1: resolve the phase (host concern — fuzzy lookup).
			const f = getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")

			// FSM validation: complete_phase requires all phases to be terminal
			const fsmError = validateFsmTransition(f, "COMPLETE_PHASE", { phaseId: phase.id })
			if (fsmError) return toolErr(fsmError)

			// Capture the phase shape BEFORE transition for grade computation
			// (need step summaries from the active phase).
			const stepSummariesText = phase.steps
				.map((st) => `  ${st.index}. ${st.description} [${st.status}]${st.grade ? ` Grade:${st.grade.grade}` : ""}`)
				.join("\n")

			// Step 2: transition phase to completed.
			const completeOutcome = applyAndPersist(params.ferment_id, {
				type: "complete_phase",
				phaseId: phase.id,
				summary: params.summary,
			})
			if (!completeOutcome.ok) return failedToolResult(completeOutcome.error)

			// Step 3: gather code evidence + grade the completed phase. Without the
			// evidence, the judge sees only worker-written summaries — which let
			// "tests pass but the integration is wrong" failures slip through.
			const startRef = getPhaseStartRef(params.ferment_id, phase.id)
			const evidence = startRef ? gatherPhaseEvidence(startRef) : undefined
			const phaseGrade = await judgeGradePhase(phase.name, phase.goal, stepSummariesText, params.summary, evidence)

			// Step 4: persist the grade.
			const gradeOutcome = applyAndPersist(params.ferment_id, {
				type: "set_phase_grade",
				phaseId: phase.id,
				grade: phaseGrade,
			})
			if (!gradeOutcome.ok) return failedToolResult(gradeOutcome.error)

			// Step 4b: self-improvement loop — for D/F grades, ask the judge for
			// one concrete corrective step to inject into the next phase's planner
			// supplement. Awaited inline (T1#11) — the previous fire-and-forget
			// version raced the next phase's activate_phase, occasionally landing
			// the suggestion one phase late. The judge call is bounded at 30s by
			// AbortSignal.timeout inside judgeApiCall, so the worst-case extra
			// latency on D/F phase completion is 30s; the typical case is a few
			// seconds. Failures are still best-effort: judgeSuggestCorrectiveStep
			// returns undefined on unreachable judge / unparseable output.
			//
			// Skip when grade was unavailable — the placeholder "B" never actually
			// triggers this branch, but if the grader returns a real "D"/"F" via
			// the unavailable path (e.g. a partial parse failure that fell back),
			// we don't trust the rationale enough to ask for a fix.
			if (!phaseGrade.unavailable && (phaseGrade.grade === "D" || phaseGrade.grade === "F")) {
				const suggestion = await judgeSuggestCorrectiveStep(phase.name, phase.goal, phaseGrade)
				if (suggestion) setCorrectiveStep(params.ferment_id, phase.id, suggestion)
			}

			onPhaseCompleted(pi)
			const fresh = gradeOutcome.ferment
			const next = fresh.phases.find((p) => p.status === "planned")
			const gradeNote = `  Grade: ${phaseGrade.grade} — ${phaseGrade.rationale}`

			if (!next) {
				return toolOk(`Phase done.${gradeNote}\nAll phases terminal. Use complete_ferment.`)
			}

			// Plan-mode TUI gate: dropdown review of completed phase + next-phase preview.
			if (isPlanMode() && ctx?.ui?.select) {
				const MAX_STEP_DESC = 80
				const completedPhase = fresh.phases.find((p) => p.id === phase.id)
				const stepLines =
					completedPhase?.steps
						.map((st) => {
							const icon =
								st.status === "done" || st.status === "verified"
									? "✓"
									: st.status === "skipped"
										? "⊘"
										: st.status === "failed"
											? "✗"
											: "○"
							const g = st.grade ? `  ${st.grade.grade}` : ""
							const desc = truncateLabel(st.description, MAX_STEP_DESC)
							return `  ${icon} ${st.index}. ${desc}${g}`
						})
						.join("\n") ?? ""

				const reviewTitle = [
					`Phase ${phase.index}: "${phase.name}"  ${phaseGrade.grade}`,
					truncateLabel(phaseGrade.rationale, 200),
					"",
					"Steps completed:",
					stepLines,
					"",
					`Next → Phase ${next.index}: "${next.name}"`,
					truncateLabel(next.goal, 200),
				].join("\n")

				const choice = await ctx.ui.select(reviewTitle, [
					`Proceed to Phase ${next.index}`,
					"Pause here",
					"Let me say something",
				])
				markHumanInput()

				if (!choice || choice === "Pause here") {
					const pauseOutcome = applyAndPersist(fresh.id, { type: "pause" })
					if (pauseOutcome.ok) setActive(pauseOutcome.ferment)
					await pi.sendUserMessage("Ferment paused. Let me know when you are ready to continue.", {
						deliverAs: "followUp",
					})
					return toolOk(`Phase done.${gradeNote}\nFerment paused at user request.`)
				}
				if (choice === "Let me say something") {
					const custom = ctx.ui.input ? await ctx.ui.input("Your message:", "") : undefined
					if (custom) await pi.sendUserMessage(custom, { deliverAs: "followUp" })
					return toolOk(`Phase done.${gradeNote}\nAwaiting user direction.`)
				}
				await pi.sendUserMessage(`Proceed to Phase ${next.index}: "${next.name}".`, { deliverAs: "followUp" })
				return toolOk(`Phase done.${gradeNote}\nUser confirmed: proceed to Phase ${next.index}.`)
			}

			return toolOk(`Phase done.${gradeNote}\nNext: "${next.name}".`)
		},
	})

	pi.registerTool({
		name: "skip_phase",
		label: "Skip Phase",
		description: "Skip a phase.",
		parameters: SkipPhaseParams,
		async execute(_, params) {
			// Resolve via fuzzy first (LLM may pass partial id).
			const f = getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")

			// FSM validation: phase must be active to skip
			const fsmError = validateFsmTransition(f, "SKIP_PHASE", { phaseId: phase.id })
			if (fsmError) return toolErr(fsmError)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "skip_phase",
				phaseId: phase.id,
				reason: params.reason,
			})
			if (!outcome.ok) return failedToolResult(outcome.error)
			return toolOk("Phase skipped.")
		},
	})

	pi.registerTool({
		name: "fail_phase",
		label: "Fail Phase",
		description: "Mark a phase as failed with a reason.",
		parameters: FailPhaseParams,
		async execute(_, params) {
			const f = getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")

			// FSM validation: phase must be active to fail
			const fsmError = validateFsmTransition(f, "FAIL_PHASE", { phaseId: phase.id })
			if (fsmError) return toolErr(fsmError)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "fail_phase",
				phaseId: phase.id,
				reason: params.reason,
			})
			if (!outcome.ok) return failedToolResult(outcome.error)
			return toolOk(
				`Phase marked as failed: ${params.reason}. Options: skip_phase to skip it, activate_phase to retry, or /ferment abandon.`,
			)
		},
	})
}
