/**
 * /progress overlay — four-layer navigation through ferment state.
 *
 * - L1 phase list   (name + bullet + step count + grade)
 * - L2 phase detail (goal, summary, step list)
 * - L3 step detail  (description, verify command, grade, result)
 * - L4 actions      (context-sensitive per phase/step status)
 *
 * Step-action and phase-action handlers also clear the stuck-loop counter when
 * the user explicitly retries or re-activates — otherwise the planner stays
 * blocked even after manual intervention.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { getScopingProgress } from "../../ferment/engine.js"
import type { Ferment, Phase, Step } from "../../ferment/types.js"
import {
	DIM,
	RST_ALL,
	RST_FG,
	SUCCESS_FG,
	formatDuration,
	gradeColor,
	phaseBullet,
	pr_bold,
	pr_dim,
	pr_orange,
	pr_success,
	pr_teal,
	stepBulletChar,
	truncateLabel,
} from "./colors.js"
import { clearStepStart, getStorage, setActive } from "./state.js"
import { getLastHumanInputAt } from "./state.js"
import { applyAndPersist } from "./tool-helpers.js"

export function buildPhaseListTitle(f: Ferment): string {
	const terminalCount = f.phases.filter(
		(p) => p.status === "completed" || p.status === "skipped" || p.status === "failed",
	).length
	const total = f.phases.length
	const barLen = 28
	const filled = total > 0 ? Math.round((terminalCount / total) * barLen) : 0
	const bar = `${SUCCESS_FG}${"█".repeat(filled)}${RST_FG}${DIM}${"░".repeat(barLen - filled)}${RST_ALL}`
	const pct = total > 0 ? Math.round((terminalCount / total) * 100) : 0
	const scopeProgress = getScopingProgress(f)
	const scopeTag = f.status === "draft" ? pr_dim(`  scoping ${scopeProgress.answered}/4`) : ""
	const fermentGrade = f.grade ? `  ${gradeColor(f.grade.grade)}` : ""
	const lastHumanInputAt = getLastHumanInputAt()
	const sinceHuman = lastHumanInputAt ? formatDuration(Date.now() - lastHumanInputAt.getTime()) : pr_dim("n/a")

	return [
		`${pr_teal("🍺")} ${pr_bold(f.name)}${fermentGrade}${scopeTag}`,
		`${bar}  ${pr_teal(`${pct}%`)}  ${pr_dim(`${terminalCount}/${total}`)}`,
		`${pr_dim("human:")} ${sinceHuman}  ${pr_dim("branch:")} ${f.worktree.branch ? pr_teal(f.worktree.branch) : pr_dim("—")}`,
		f.goal ? `${pr_dim("goal:")} ${truncateLabel(f.goal, 70)}` : "",
	]
		.filter(Boolean)
		.join("\n")
}

export function buildPhaseListOptions(f: Ferment): string[] {
	const opts = f.phases.map((p) => {
		const isActive = p.id === f.activePhaseId || (p.groupIndex !== undefined && p.status === "active")
		const bullet = phaseBullet(p)
		const parallelTag = p.groupIndex !== undefined ? pr_dim("∥ ") : ""
		const name = isActive ? pr_teal(p.name) : p.status === "completed" ? pr_dim(p.name) : p.name
		const stepsDone = p.steps.filter(
			(s) => s.status === "done" || s.status === "verified" || s.status === "skipped",
		).length
		const stepsTag = p.steps.length > 0 ? pr_dim(`  ${stepsDone}/${p.steps.length}`) : ""
		const gradeTag = p.grade ? `  ${gradeColor(p.grade.grade)}` : ""
		return `${bullet}  ${parallelTag}${name}${stepsTag}${gradeTag}`
	})
	opts.push(pr_dim("─────────────────────────"))
	if (f.status !== "complete" && f.status !== "abandoned") opts.push("Abandon ferment")
	opts.push("Close")
	return opts
}

export function buildPhaseDetailTitle(f: Ferment, p: Phase): string {
	const isActive = p.id === f.activePhaseId
	const bullet = phaseBullet(p)
	const stepsDone = p.steps.filter(
		(s) => s.status === "done" || s.status === "verified" || s.status === "skipped" || s.status === "failed",
	).length
	const stepsTag = p.steps.length > 0 ? pr_dim(`  ${stepsDone}/${p.steps.length} steps`) : ""
	const gradeTag = p.grade ? `  ${gradeColor(p.grade.grade)}  ${pr_dim(p.grade.rationale)}` : ""

	const lines: string[] = [
		`${pr_dim(`Phase ${p.index}/${f.phases.length}`)}  ${pr_bold(f.name)}`,
		`${bullet}  ${pr_bold(p.name)}${stepsTag}${gradeTag}`,
		`   ${pr_dim(p.goal)}`,
	]
	if (p.constraints?.length) lines.push(`   ${pr_dim("constraints:")} ${pr_dim(p.constraints.join(", "))}`)
	if (p.summary) lines.push(`   ${pr_dim("↳")} ${pr_dim(p.summary)}`)
	if (isActive && p.steps.length === 0) lines.push(`   ${pr_dim("no steps yet — agent will refine")}`)
	return lines.join("\n")
}

export function buildPhaseStepOptions(p: Phase): string[] {
	// When no steps exist, only show actionable options — never include the
	// "No steps" label as a selectable item (the user can read it from the title).
	if (p.steps.length === 0) return ["Phase actions", "Back"]
	const opts = p.steps.map((s) => {
		const bullet = stepBulletChar(s.status)
		const name =
			s.status === "running"
				? pr_teal(s.description)
				: s.status === "failed"
					? pr_orange(s.description)
					: s.status === "done" || s.status === "verified"
						? pr_dim(s.description)
						: s.description
		const gradeTag = s.grade ? `  ${gradeColor(s.grade.grade)}` : ""
		return `${bullet}  ${name}${gradeTag}`
	})
	opts.push(pr_dim("─────────────────────────"))
	opts.push("Phase actions")
	opts.push("Back")
	return opts
}

export function buildStepDetailTitle(p: Phase, s: Step): string {
	const bullet = stepBulletChar(s.status)
	const gradeTag = s.grade ? `  ${gradeColor(s.grade.grade)}  ${pr_dim(s.grade.rationale)}` : ""
	const lines: string[] = [
		`${pr_dim(`Step ${s.index}/${p.steps.length}`)}  ${pr_bold(p.name)}`,
		`${bullet}  ${pr_bold(s.description)}${gradeTag}`,
	]
	if (s.summary) {
		// Worker-written summary of what the step accomplished. Symmetric with
		// the phase-detail rendering of `p.summary`.
		lines.push(`   ${pr_dim("↳")} ${pr_dim(s.summary)}`)
	}
	if (s.verification) {
		lines.push(`   ${pr_dim("verify:")} ${pr_teal(s.verification.command)}`)
	}
	if (s.result) {
		const exitColor = s.result.exitCode === 0 ? pr_success : pr_orange
		lines.push(`   ${pr_dim("exit:")} ${exitColor(String(s.result.exitCode ?? "—"))}`)
		if (s.result.stdout) lines.push(`   ${pr_dim("stdout:")} ${truncateLabel(s.result.stdout.trim(), 120)}`)
		if (s.result.stderr) lines.push(`   ${pr_dim("stderr:")} ${pr_orange(truncateLabel(s.result.stderr.trim(), 120))}`)
	}
	if (s.startedAt) lines.push(`   ${pr_dim("started:")} ${pr_dim(s.startedAt.slice(0, 19))}`)
	if (s.completedAt) lines.push(`   ${pr_dim("done:")}    ${pr_dim(s.completedAt.slice(0, 19))}`)
	return lines.join("\n")
}

export function buildStepActionOptions(_p: Phase, s: Step): string[] {
	const opts: string[] = []
	if (s.status === "pending" || s.status === "running") opts.push("Mark step done")
	if (s.status === "failed") {
		opts.push("Retry step")
		opts.push("Skip step")
	}
	if (s.status !== "skipped") opts.push("Skip step")
	opts.push(pr_dim("─────────────────────────"))
	opts.push("Back to phase")
	return opts
}

export function buildPhaseActionOptions(f: Ferment, p: Phase): string[] {
	const isActive = p.id === f.activePhaseId
	const opts: string[] = []
	if (p.status === "planned" && !isActive) opts.push("Activate phase")
	if ((p.status === "active" || isActive) && p.steps.length === 0) opts.push("Ask agent to refine steps")
	if (p.status === "active" || isActive) {
		const allDone =
			p.steps.length > 0 &&
			p.steps.every(
				(s) => s.status === "done" || s.status === "verified" || s.status === "skipped" || s.status === "failed",
			)
		if (allDone) opts.push("Mark phase complete")
		opts.push("Mark phase failed")
		opts.push("Skip phase")
	}
	if (p.status === "failed") {
		opts.push("Re-activate phase")
		opts.push("Skip phase")
	}
	opts.push(pr_dim("─────────────────────────"))
	opts.push("Back to steps")
	return opts
}

export async function handleStepAction(
	choice: string,
	f: Ferment,
	p: Phase,
	s: Step,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (choice === "Mark step done") {
		const out = applyAndPersist(f.id, { type: "complete_step", phaseId: p.id, stepId: s.id })
		if (out.ok) setActive(out.ferment)
		clearStepStart(f.id, p.id, s.id)
		ctx.ui.notify(out.ok ? `Step ${s.index} marked done.` : `Could not complete step: ${out.error.message}`)
	} else if (choice === "Retry step") {
		const out = applyAndPersist(f.id, { type: "start_step", phaseId: p.id, stepId: s.id })
		if (out.ok) setActive(out.ferment)
		// User explicitly chose retry — reset stuck-loop counter so the agent isn't blocked
		clearStepStart(f.id, p.id, s.id)
		ctx.ui.notify(
			out.ok ? `Step ${s.index} reset to running — tell the agent to retry.` : `Could not retry: ${out.error.message}`,
		)
	} else if (choice === "Skip step") {
		const out = applyAndPersist(f.id, { type: "skip_step", phaseId: p.id, stepId: s.id })
		if (out.ok) setActive(out.ferment)
		clearStepStart(f.id, p.id, s.id)
		ctx.ui.notify(out.ok ? `Step ${s.index} skipped.` : `Could not skip: ${out.error.message}`)
	}
}

export async function handlePhaseAction(
	choice: string,
	f: Ferment,
	p: Phase,
	ctx: ExtensionCommandContext,
): Promise<void> {
	switch (choice) {
		case "Activate phase": {
			// activate_phase transitions ferment.status to "running" — no need for a separate updateStatus.
			const out = applyAndPersist(f.id, { type: "activate_phase", phaseId: p.id })
			if (out.ok) setActive(out.ferment)
			ctx.ui.notify(out.ok ? `Phase "${p.name}" activated.` : `Could not activate: ${out.error.message}`)
			break
		}
		case "Ask agent to refine steps":
			ctx.ui.notify(`Tell the agent: refine_phase for phase ${p.index} "${p.name}"`)
			break
		case "Mark phase complete": {
			const out = applyAndPersist(f.id, { type: "complete_phase", phaseId: p.id, summary: "Completed via /progress" })
			if (out.ok) setActive(out.ferment)
			ctx.ui.notify(out.ok ? `Phase "${p.name}" complete.` : `Could not complete: ${out.error.message}`)
			break
		}
		case "Mark phase failed": {
			const reason = ctx.ui.input ? await ctx.ui.input("Reason for failure:", "") : ""
			const out = applyAndPersist(f.id, {
				type: "fail_phase",
				phaseId: p.id,
				reason: reason || "Failed via /progress",
			})
			if (out.ok) setActive(out.ferment)
			ctx.ui.notify(out.ok ? `Phase "${p.name}" marked failed.` : `Could not fail: ${out.error.message}`)
			break
		}
		case "Skip phase": {
			const out = applyAndPersist(f.id, { type: "skip_phase", phaseId: p.id, reason: "Skipped via /progress" })
			if (out.ok) setActive(out.ferment)
			ctx.ui.notify(out.ok ? `Phase "${p.name}" skipped.` : `Could not skip: ${out.error.message}`)
			break
		}
		case "Re-activate phase": {
			const out = applyAndPersist(f.id, { type: "activate_phase", phaseId: p.id })
			if (out.ok) {
				setActive(out.ferment)
				// Reload phase from the post-state so we clear counters for the current step set, not
				// the stale closure copy (audit doc finding #7).
				const freshPhase = out.ferment.phases.find((ph) => ph.id === p.id)
				for (const step of freshPhase?.steps ?? []) {
					clearStepStart(f.id, p.id, step.id)
				}
			}
			ctx.ui.notify(out.ok ? `Phase "${p.name}" re-activated.` : `Could not re-activate: ${out.error.message}`)
			break
		}
	}
}
