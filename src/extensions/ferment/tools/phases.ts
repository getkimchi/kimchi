/**
 * Phase tools: activate_phase, refine_phase, complete_phase, skip_phase, fail_phase.
 *
 * complete_phase is the most complex — in plan mode it surfaces a TUI dropdown
 * with a structured phase review and routes the response back to the planner
 * via `pi.sendUserMessage(..., { deliverAs: "followUp" })`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { findFirstPlannedPhase } from "../../../ferment/engine.js"
import type { Step } from "../../../ferment/types.js"
import { truncateLabel } from "../colors.js"
import { formatDecisionsAndMemories, formatScopingContext } from "../format.js"
import { judgeGradePhase } from "../judge.js"
import { isPlanMode } from "../modes.js"
import { onPhaseCompleted } from "../nudge.js"
import { captureJudgeContext, getStorage, markHumanInput, setActive } from "../state.js"
import { resolvePhase, toolErr } from "../tool-helpers.js"
import { ActivateParams, CompletePhaseParams, FailPhaseParams, RefineParams, SkipPhaseParams } from "../tool-schemas.js"

export function registerPhaseTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "activate_phase",
		label: "Activate Phase",
		description: "Start a planned phase.",
		parameters: ActivateParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")

			// Resolve target phase: by id, by name, or fallback to first planned
			let target = params.phase_id ? f.phases.find((p) => p.id === params.phase_id) : undefined
			if (!target && params.phase_id) {
				const name = params.phase_id.toLowerCase()
				target = f.phases.find((p) => p.name.toLowerCase().includes(name))
			}
			if (!target) {
				target = findFirstPlannedPhase(f)
			}
			if (!target) return toolErr("No planned phases to activate.")

			// Detect parallel group — activate all siblings at once
			if (target.groupIndex !== undefined) {
				const r = s.activatePhaseGroup(f.id, target.groupIndex)
				if (!r) return toolErr("Phase group activation failed.")
				setActive(r)
				s.updateStatus(f.id, "running")
				const groupPhases = r.phases.filter((p) => p.groupIndex === target.groupIndex && p.status === "active")
				const phaseLines = groupPhases
					.map((gp) => {
						const stepList =
							gp.steps.length > 0
								? `\n    Steps:\n${gp.steps.map((st) => `      ${st.index}. [${st.id}] ${st.description}`).join("\n")}`
								: "\n    No steps yet — call refine_phase to populate them."
						return `  ∥ [${gp.id}] ${gp.index}. "${gp.name}"${stepList}`
					})
					.join("\n")
				const dmParallel = formatDecisionsAndMemories(r)
				const dmParallelSection = dmParallel ? `\n\n${dmParallel}` : ""
				const scParallel = formatScopingContext(r)
				const scParallelSection = scParallel ? `\n\n${scParallel}` : ""
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Parallel group ${target.groupIndex} activated (${groupPhases.length} phases running concurrently).\nferment_id: ${f.id}\nparallel_group: ${target.groupIndex}\nphase_ids: ${groupPhases.map((p) => p.id).join(", ")}\n\n${phaseLines}\n\nRun all parallel phases concurrently: call refine_phase + start_step for each phase simultaneously.${scParallelSection}${dmParallelSection}`,
						},
					],
				}
			}

			const r = s.activatePhase(f.id, target.id)
			if (!r) return toolErr("Phase activation failed.")
			setActive(r)
			s.updateStatus(f.id, "running")
			const activatedPhase = r.phases.find((p) => p.id === target.id)
			const stepList =
				activatedPhase && activatedPhase.steps.length > 0
					? `\nSteps:\n${activatedPhase.steps.map((st) => `  ${st.index}. [${st.id}] ${st.description}`).join("\n")}`
					: "\nNo steps yet — call refine_phase to populate them."
			const dm = formatDecisionsAndMemories(r)
			const dmSection = dm ? `\n\n${dm}` : ""
			const sc = formatScopingContext(r)
			const scSection = sc ? `\n\n${sc}` : ""
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Phase "${target.name}" activated.\nferment_id: ${f.id}\nphase_id: ${target.id}${stepList}${scSection}${dmSection}`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "refine_phase",
		label: "Refine Phase",
		description: "Add steps to an active phase. Overwrites existing. Use the phase_id returned by activate_phase.",
		parameters: RefineParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			// Resolve phase: exact id → name substring → active phase fallback
			let phase = f.phases.find((p) => p.id === params.phase_id)
			if (!phase) {
				const needle = params.phase_id.toLowerCase()
				phase = f.phases.find((p) => p.name.toLowerCase().includes(needle))
			}
			if (!phase) {
				const active = f.phases.find((p) => p.status === "active")
				if (active) phase = active
			}
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
			if (phase.status !== "active") {
				return toolErr(`Phase must be active. Current: ${phase.status}`)
			}

			const steps: Step[] = params.steps.map((st, i) => ({
				id: `step-${i + 1}`,
				index: i + 1,
				description: st.description,
				status: "pending",
				needsVision: st.needs_vision ?? false,
				workerModel: st.needs_vision ? "kimi-k2.5" : "minimax-m2.7",
				canRunParallel: st.can_run_parallel ?? false,
				verification: st.verify ? { command: st.verify, retries: 2, retryDelayMs: 1000 } : undefined,
			}))
			const r = s.refinePhase(f.id, phase.id, steps)
			if (r) setActive(r)
			const stepList = steps.map((st, i) => `  ${i + 1}. [step-${i + 1}] ${st.description}`).join("\n")
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `"${phase.name}" refined with ${steps.length} step(s).\nferment_id: ${f.id}\nphase_id: ${phase.id}\n${stepList}\nCall start_step with step_id to begin.`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "complete_phase",
		label: "Complete Phase",
		description: "Mark phase as completed. Judge grades the phase based on step results.",
		parameters: CompletePhaseParams,
		async execute(_, params, _signal, _onUpdate, ctx) {
			captureJudgeContext(ctx?.model, ctx?.modelRegistry)
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")

			const r = s.completePhase(f.id, phase.id, params.summary)
			if (!r) return toolErr("Phase completion failed.")
			setActive(r)

			// ── Grade the phase ──────────────────────────────────────────────────
			const stepSummaries = phase.steps
				.map((st) => `  ${st.index}. ${st.description} [${st.status}]${st.grade ? ` Grade:${st.grade.grade}` : ""}`)
				.join("\n")
			const phaseGrade = await judgeGradePhase(phase.name, phase.goal, stepSummaries, params.summary)
			const graded = s.setPhaseGrade(f.id, phase.id, phaseGrade)
			if (graded) setActive(graded)

			onPhaseCompleted(pi)
			const fresh = s.get(f.id) ?? r
			const next = fresh.phases.find((p) => p.status === "planned")
			const gradeNote = `  Grade: ${phaseGrade.grade} — ${phaseGrade.rationale}`

			if (next) {
				if (isPlanMode() && ctx?.ui?.select) {
					// Build a structured phase review for the user. Hard cap step
					// descriptions to keep the dropdown title from overflowing the terminal.
					const MAX_STEP_DESC = 80
					const stepLines = phase.steps
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
						.join("\n")
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
						getStorage().updateStatus(fresh.id, "paused")
						const paused = getStorage().get(fresh.id)
						if (paused) setActive(paused)
						await pi.sendUserMessage("Ferment paused. Let me know when you are ready to continue.", {
							deliverAs: "followUp",
						})
						return {
							details: undefined,
							content: [{ type: "text", text: `Phase done.${gradeNote}\nFerment paused at user request.` }],
						}
					}
					if (choice === "Let me say something") {
						const custom = ctx.ui.input ? await ctx.ui.input("Your message:", "") : undefined
						if (custom) await pi.sendUserMessage(custom, { deliverAs: "followUp" })
						return {
							details: undefined,
							content: [{ type: "text", text: `Phase done.${gradeNote}\nAwaiting user direction.` }],
						}
					}
					await pi.sendUserMessage(`Proceed to Phase ${next.index}: "${next.name}".`, { deliverAs: "followUp" })
					return {
						details: undefined,
						content: [
							{ type: "text", text: `Phase done.${gradeNote}\nUser confirmed: proceed to Phase ${next.index}.` },
						],
					}
				}
				return {
					details: undefined,
					content: [{ type: "text", text: `Phase done.${gradeNote}\nNext: "${next.name}".` }],
				}
			}
			return {
				details: undefined,
				content: [{ type: "text", text: `Phase done.${gradeNote}\nAll phases terminal. Use complete_ferment.` }],
			}
		},
	})

	pi.registerTool({
		name: "skip_phase",
		label: "Skip Phase",
		description: "Skip a phase.",
		parameters: SkipPhaseParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const r = s.skipPhase(f.id, params.phase_id, params.reason)
			if (!r) return toolErr("Phase not found.")
			setActive(r)
			return { details: undefined, content: [{ type: "text", text: "Phase skipped." }] }
		},
	})

	pi.registerTool({
		name: "fail_phase",
		label: "Fail Phase",
		description: "Mark a phase as failed with a reason.",
		parameters: FailPhaseParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")
			const r = s.failPhase(f.id, phase.id, params.reason)
			if (!r) return toolErr("Failed to mark phase as failed.")
			setActive(r)
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Phase marked as failed: ${params.reason}. Options: skip_phase to skip it, activate_phase to retry, or /ferment abandon.`,
					},
				],
			}
		},
	})
}
