/**
 * Ferment Engine v4 — Progressive Refinement
 *
 * Reads the ferment JSON state and returns the next Action for the LLM.
 * Mode-aware: plan mode (coaching), exec mode (auto-advance), auto mode (mixed).
 */

import type { Ferment, FermentAction, Phase, Scoping, Step } from "./types.js"

export function whatNext(ferment: Ferment): FermentAction {
	switch (ferment.mode) {
		case "plan":
			return planModeAction(ferment)
		case "exec":
			return execModeAction(ferment)
		default:
			return autoModeAction(ferment)
	}
}

// ─── Plan Mode — Scoping, review gates, user-confirmed execution ──────────────

function planModeAction(ferment: Ferment): FermentAction {
	switch (ferment.status) {
		case "draft":
			return {
				kind: "scope",
				message: buildPlanScopeMessage(ferment),
			}

		case "planned": {
			const next = findFirstPlannedPhase(ferment)
			if (next) {
				return {
					kind: "activate_phase",
					phaseId: next.id,
					message: `Ferment "${ferment.name}" is planned with ${ferment.phases.length} phase(s). Present the plan to the user for review:\n\n${formatPhases(ferment)}\n\nAsk the user: "Ready to start Phase ${next.index}: '${next.name}'?" — wait for explicit confirmation before calling activate_phase.`,
				}
			}
			return {
				kind: "complete_ferment",
				message: `All ${ferment.phases.length} phase(s) are terminal. Ask the user if they want to mark the ferment as complete.`,
			}
		}

		case "running": {
			const active = findActivePhase(ferment)
			if (!active) {
				return {
					kind: "paused",
					message: `Ferment is in "running" status but no phase is active. Ask the user what they would like to do next.`,
				}
			}
			if (active.status === "failed") {
				return {
					kind: "recover_phase",
					phaseId: active.id,
					message: `Phase ${active.index} "${active.name}" has failed${active.summary ? `: ${active.summary}` : ""}. Ask the user: retry, skip, or abandon the ferment?`,
				}
			}
			if (active.steps.length === 0) {
				return {
					kind: "refine",
					phaseId: active.id,
					message: `Phase ${active.index} "${active.name}" is active. Break it into 3–6 concrete steps. When ready, present the proposed steps to the user for review before starting.`,
				}
			}
			const next = findNextStep(active)
			if (next) {
				if (next.status === "failed") {
					return {
						kind: "recover_step",
						stepId: next.id,
						phaseId: active.id,
						message: `Step ${next.index} "${next.description}" has failed. Ask the user: retry, skip, or revise this step?`,
					}
				}
				return {
					kind: "start_step",
					stepId: next.id,
					message: `Phase ${active.index} "${active.name}" — Step ${next.index}/${active.steps.length}: "${next.description}". Ask the user to confirm before starting: "Ready to execute this step?"`,
				}
			}
			return {
				kind: "complete_phase",
				phaseId: active.id,
				message: `Phase ${active.index} "${active.name}" has all steps terminal. Present a summary to the user and ask them to confirm completing this phase.`,
			}
		}

		case "paused":
			return {
				kind: "paused",
				message: `Ferment "${ferment.name}" is paused. Ask the user what they want to do next.\n\n${formatStatus(ferment)}`,
			}

		case "complete":
		case "abandoned":
			return {
				kind: "complete_ferment",
				message: `Ferment "${ferment.name}" is ${ferment.status}. ${buildSummary(ferment)}`,
			}
	}
}

function buildPlanScopeMessage(f: Ferment): string {
	const s = f.scoping
	const missing: string[] = []
	if (!s.goal) missing.push("Goal")
	if (!s.criteria) missing.push("Success Criteria")
	if (!s.constraints) missing.push("Constraints")
	if (!s.phases) missing.push("Phase Breakdown")

	if (missing.length === 0) {
		return `All scoping questions answered for ferment "${f.name}" (ID: ${f.id}).\n\nPresent a review to the user:\n${buildScopeReview(f)}\n\nAsk: "Does this look right? Type 'yes' to confirm and start planning, or tell me what to revise."\nWhen confirmed, call scope_ferment with ferment_id "${f.id}" and all collected answers.`
	}

	const answered: string[] = []
	if (s.goal) answered.push("Goal")
	if (s.criteria) answered.push("Success Criteria")
	if (s.constraints) answered.push("Constraints")
	if (s.phases) answered.push("Phase Breakdown")

	const answeredMsg = answered.length > 0 ? `\nAlready collected: ${answered.join(", ")}.` : ""
	return `You are scoping ferment "${f.name}" (ID: ${f.id}).\n\nStill need to collect: ${missing.join(", ")}.${answeredMsg}\n\nAsk the user for each missing item conversationally — one question at a time. When all are answered, show them a review and wait for confirmation before calling scope_ferment.`
}

function buildScopeReview(f: Ferment): string {
	const s = f.scoping
	const lines: string[] = []
	if (s.goal) lines.push(`• Goal: ${s.goal.answer}`)
	if (s.criteria) lines.push(`• Success criteria: ${s.criteria.answer}`)
	if (s.constraints) lines.push(`• Constraints: ${s.constraints.answer}`)
	if (s.phases) {
		lines.push(`• Phases: ${f.phases.length} planned`)
		for (const p of f.phases) {
			lines.push(`  ${p.index}. ${p.name} — ${p.goal}`)
		}
	}
	return lines.join("\n")
}

function formatPhases(f: Ferment): string {
	if (f.phases.length === 0) return "No phases defined yet."
	return f.phases.map((p) => `${p.index}. ${p.name} — ${p.goal}`).join("\n")
}

function formatSteps(f: Ferment, p: Phase): string {
	if (p.steps.length === 0) return "No steps defined yet. Use refine_phase to populate them."
	return p.steps.map((s) => `${s.index}. ${s.description}`).join("\n")
}

function formatStatus(f: Ferment): string {
	return `Status: ${f.status}, ${f.phases.filter((p) => p.status === "completed" || p.status === "skipped").length}/${f.phases.length} phases done.`
}

// ─── Exec Mode — Auto-advance, stripped coaching ──────────────────────────────

function execModeAction(ferment: Ferment): FermentAction {
	const action = autoModeAction(ferment)
	if (action.kind === "scope") {
		return {
			...action,
			message: `Ferment "${ferment.name}" (${short(ferment.id)}…) is in draft. Collect goal, criteria, constraints, and phases. Store with scope_ferment.`,
		}
	}
	if (action.kind === "activate_phase") {
		return {
			...action,
			message: action.message.replace(/\.\s+Use activate_phase.*$/, "."),
		}
	}
	if (action.kind === "refine") {
		const stripped = action.message
			.split("\n")
			.filter((line) => !line.startsWith("Use ") && !line.includes("Use refine_phase"))
			.join("\n")
		return { ...action, message: stripped }
	}
	if (action.kind === "start_step") {
		return {
			...action,
			message: action.message.replace(/\.\s+Execute this step[\s\S]*/, ".").replace(/\.\s+Ask the user[\s\S]*/, "."),
		}
	}
	if (action.kind === "complete_step") {
		return {
			...action,
			message: action.message.replace(/\.\s+When complete, use complete_step[\s\S]*/, ". Execute and verify."),
		}
	}
	if (action.kind === "complete_phase") {
		return {
			...action,
			message: action.message
				.replace(/\.\s+Summarize what was accomplished[\s\S]*/, ".")
				.replace(/\.\s+Present a summary[\s\S]*/, "."),
		}
	}
	if (action.kind === "recover_step" || action.kind === "recover_phase") {
		return action
	}
	return action
}

function short(id: string): string {
	return id.slice(0, 8)
}

// ─── Auto Mode — Full coaching, user decides ──────────────────────────────────

function autoModeAction(ferment: Ferment): FermentAction {
	switch (ferment.status) {
		case "draft":
			return {
				kind: "scope",
				message: buildAutoScopeMessage(ferment),
			}

		case "planned": {
			const next = findFirstPlannedPhase(ferment)
			if (next) {
				return {
					kind: "activate_phase",
					phaseId: next.id,
					message: `The ferment "${ferment.name}" is planned with ${ferment.phases.length} phase(s). Start Phase ${next.index}: "${next.name}" — ${next.goal}. Use activate_phase to begin execution.`,
				}
			}
			return {
				kind: "complete_ferment",
				message: `All ${ferment.phases.length} phase(s) are already terminal. The ferment "${ferment.name}" can be completed.`,
			}
		}

		case "running": {
			const active = findActivePhase(ferment)
			if (!active) {
				return {
					kind: "paused",
					message: `The ferment is in "running" status but no phase is active. This may be a recovered state. Activate the next planned phase or switch status to "planned".`,
				}
			}
			if (active.status === "failed") {
				return {
					kind: "recover_phase",
					phaseId: active.id,
					message: `Phase ${active.index} "${active.name}" has failed${active.summary ? `: ${active.summary}` : ""}. Options: retry (re-activate), skip (mark skipped), or abandon the ferment (/ferment abandon).`,
				}
			}
			// Detect explore phase — discourage individual exploratory tools
			const isExplorePhase = active.name.toLowerCase().includes("explore")
			if (isExplorePhase) {
				return {
					kind: "paused",
					message: `You are in the "${active.name}" phase. Use subagents (e.g. /research or /explore) for code research — do NOT make individual read_file, list_directory, or search_code calls yourself. Delegate the exploration work.`,
				}
			}
			if (active.steps.length === 0) {
				return {
					kind: "refine",
					phaseId: active.id,
					message: buildRefineMessage(ferment, active),
				}
			}
			const nextStep = findNextStep(active)
			if (nextStep) {
				if (nextStep.status === "failed") {
					return {
						kind: "recover_step",
						stepId: nextStep.id,
						phaseId: active.id,
						message: `Step ${nextStep.index} "${nextStep.description}" has failed${nextStep.result?.stderr ? `: ${nextStep.result.stderr}` : ""}. Options: retry, skip this step, or revise it (/ferment revise step <description>).`,
					}
				}
				if (nextStep.status === "pending") {
					return {
						kind: "start_step",
						stepId: nextStep.id,
						message: buildStartStepMessage(ferment, active, nextStep),
					}
				}
				if (nextStep.status === "running") {
					return {
						kind: "start_step",
						stepId: nextStep.id,
						message: `Continue the current step: "${nextStep.description}" (Phase ${active.index}: ${active.name}).`,
					}
				}
			}
			return {
				kind: "complete_phase",
				phaseId: active.id,
				message: `Phase ${active.index} "${active.name}" is complete (${countTerminal(active.steps)}/${active.steps.length} steps terminal). Summarize what was accomplished and mark the phase as completed.`,
			}
		}

		case "paused":
			return {
				kind: "paused",
				message: `The ferment "${ferment.name}" is paused. Type /auto to resume, or ask to make changes.`,
			}

		case "complete":
		case "abandoned":
			return {
				kind: "complete_ferment",
				message: `The ferment "${ferment.name}" is ${ferment.status}. ${buildSummary(ferment)}`,
			}
	}
}

function buildAutoScopeMessage(f: Ferment): string {
	return `You are scoping a new ferment: "${f.name}" (ID: ${short(f.id)}…).\n\nGuide the user through defining this ferment. Collect:\n1. What does "done" look like? (goal)\n2. What is the definition of done? (success criteria)\n3. Constraints (what to avoid)\n4. Breakdown into 3–7 ordered phases\n\nThen call scope_ferment with all collected information.`
}

function buildRefineMessage(f: Ferment, p: Phase): string {
	let msg = `Phase ${p.index}: "${p.name}" is now active. The goal is: ${p.goal}.\n`
	if (p.constraints && p.constraints.length > 0) {
		msg += `\nConstraints: ${p.constraints.join(", ")}\n`
	}
	if (p.budget) {
		msg += `Budget: ${p.budget}\n`
	}
	msg += "\nBreak this phase into 3–6 concrete, independently verifiable steps. Each step should have:\n"
	msg += "- A clear description\n"
	msg += "- An optional verification command (exit 0 = success)\n\n"
	msg += "Use refine_phase to populate the steps, then execute them one at a time."
	return msg
}

function buildStartStepMessage(f: Ferment, p: Phase, s: Step): string {
	let msg = `Phase ${p.index}: "${p.name}" — Step ${s.index}/${p.steps.length}: "${s.description}"\n`
	if (s.verification) {
		msg += `\nVerification: \`${s.verification.command}\`\n`
	}
	msg += "\nExecute this step. When complete, use complete_step with a summary of what was done."
	return msg
}

function buildSummary(f: Ferment): string {
	const completed = f.phases.filter((p) => p.status === "completed" || p.status === "skipped").length
	const total = f.phases.length
	const dec = f.decisions.length
	const mem = f.memories.length
	return `${completed}/${total} phases terminal. ${dec} decisions, ${mem} memories recorded.`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function findFirstPlannedPhase(f: Ferment): Phase | undefined {
	return f.phases.find((p) => p.status === "planned")
}

export function isScopingComplete(f: Ferment): boolean {
	return !!(f.scoping.goal && f.scoping.criteria && f.scoping.constraints && f.scoping.phases)
}

export function getScopingProgress(f: Ferment): { answered: number; total: number } {
	const s = f.scoping
	let answered = 0
	if (s.goal) answered++
	if (s.criteria) answered++
	if (s.constraints) answered++
	if (s.phases) answered++
	return { answered, total: 4 }
}

function findActivePhase(f: Ferment): Phase | undefined {
	if (f.activePhaseId) {
		return f.phases.find((p) => p.id === f.activePhaseId)
	}
	return f.phases.find((p) => p.status === "active")
}

function findNextStep(p: Phase): Step | undefined {
	return p.steps.find((s) => s.status !== "done" && s.status !== "skipped" && s.status !== "verified")
}

function countTerminal(steps: Step[]): number {
	return steps.filter(
		(s) => s.status === "done" || s.status === "verified" || s.status === "skipped" || s.status === "failed",
	).length
}
