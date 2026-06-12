import type { Theme } from "@earendil-works/pi-coding-agent"
import { matchesKey } from "@earendil-works/pi-tui"
import { gradeColor, stepBulletChar } from "../colors.js"
import { phaseBarTone, segBar } from "./bars.js"
import { computeVisibleWindow, divider, formatElapsed, padText, selectedLine, truncateText } from "./layout.js"
import type { PanelSnapshot, PanelStepRow } from "./snapshot.js"
import type { FermentTrace } from "./trace.js"

type ProgressItem =
	| { kind: "phase"; id: string; index: number }
	| { kind: "step"; id: string; phaseId: string; index: number }

export class ProgressViewState {
	selected = 0
	expandedPhaseId?: string
	detailStepId?: string

	resetToActive(snapshot: PanelSnapshot | undefined): void {
		if (!snapshot) {
			this.selected = 0
			this.expandedPhaseId = undefined
			this.detailStepId = undefined
			return
		}
		const phase = snapshot.phases[snapshot.activePhaseIndex] ?? snapshot.phases[0]
		this.expandedPhaseId = phase?.id
		this.selected = Math.max(0, snapshot.activePhaseIndex)
	}
}

function displayGrade(grade: string | undefined): string {
	if (!grade) return ""
	return grade.length === 1 ? gradeColor(grade as "A" | "B" | "C" | "D" | "F") : grade
}

function statusLabel(row: PanelSnapshot["phases"][number]): string {
	if (row.awaitingInput) return "await"
	if (row.status === "completed") return "done"
	if (row.status === "active") {
		if (row.totalSteps === 0) return "active"
		return `${Math.round((row.doneSteps / row.totalSteps) * 100)}%`
	}
	if (row.status === "planned") return "wait"
	return row.status
}

function activePhaseId(snapshot: PanelSnapshot, state: ProgressViewState): string | undefined {
	return state.expandedPhaseId ?? snapshot.activePhaseId ?? snapshot.phases[0]?.id
}

function progressItems(snapshot: PanelSnapshot, state: ProgressViewState): ProgressItem[] {
	const phaseId = activePhaseId(snapshot, state)
	const phaseItems: ProgressItem[] = snapshot.phases.map((phase, index) => ({
		kind: "phase",
		id: phase.id,
		index,
	}))
	const stepItems: ProgressItem[] = (phaseId ? (snapshot.stepsByPhase.get(phaseId) ?? []) : []).map((step, index) => ({
		kind: "step",
		id: step.id,
		phaseId: step.phaseId,
		index,
	}))
	return [...phaseItems, ...stepItems]
}

export function handleProgressInput(
	data: string,
	snapshot: PanelSnapshot | undefined,
	state: ProgressViewState,
): boolean {
	if (!snapshot) return false
	const items = progressItems(snapshot, state)
	if (items.length === 0) return false

	if (matchesKey(data, "down") || matchesKey(data, "j")) {
		state.selected = Math.min(items.length - 1, state.selected + 1)
		return true
	}
	if (matchesKey(data, "up") || matchesKey(data, "k")) {
		state.selected = Math.max(0, state.selected - 1)
		return true
	}
	if (matchesKey(data, "g")) {
		state.resetToActive(snapshot)
		return true
	}
	if (matchesKey(data, "return")) {
		const item = items[state.selected]
		if (!item) return true
		if (item.kind === "phase") {
			state.expandedPhaseId = item.id
			state.detailStepId = undefined
			return true
		}
		state.detailStepId = state.detailStepId === item.id ? undefined : item.id
		return true
	}
	return false
}

function renderPhaseRail(
	snapshot: PanelSnapshot,
	state: ProgressViewState,
	width: number,
	theme: Theme,
	maxRows: number,
): string[] {
	const rows = snapshot.phases
	const { start, end } = computeVisibleWindow(Math.min(state.selected, rows.length - 1), rows.length, maxRows)
	const lines: string[] = []
	for (let i = start; i < end; i++) {
		const row = rows[i]
		if (!row) continue
		const selected = state.selected === i
		const prefix = row.active ? theme.fg("accent", "▌") : " "
		const idx = String(row.index).padStart(2, "0")
		const nameWidth = Math.max(8, width - 28)
		const name = truncateText(`${row.name}${row.parallel ? " ∥" : ""}`, nameWidth)
		const barWidth = Math.max(6, Math.min(16, width - nameWidth - 14))
		const bar = segBar(row.doneSteps, row.totalSteps, barWidth, theme, phaseBarTone(row.status))
		const grade = displayGrade(row.grade)
		const status = row.awaitingInput ? theme.fg("warning", "awaiting input") : statusLabel(row)
		const plain = `${prefix} ${idx} ${padText(name, nameWidth)} ${bar} ${grade ? `${grade} ` : ""}${status}`
		lines.push(selected ? selectedLine(theme, plain, width) : padText(plain, width))
	}
	while (lines.length < maxRows) lines.push(" ".repeat(width))
	return lines
}

function renderStepDetail(step: PanelStepRow, width: number, theme: Theme): string[] {
	const lines: string[] = []
	if (step.summary) lines.push(theme.fg("dim", `summary  ${truncateText(step.summary, Math.max(0, width - 9))}`))
	if (step.verificationCommand)
		lines.push(theme.fg("dim", `verify   ${truncateText(step.verificationCommand, Math.max(0, width - 9))}`))
	if (step.resultExitCode !== undefined) lines.push(theme.fg("dim", `exit     ${step.resultExitCode}`))
	if (step.resultStdout)
		lines.push(
			theme.fg("dim", `stdout   ${truncateText(step.resultStdout.replace(/\s+/g, " "), Math.max(0, width - 9))}`),
		)
	if (step.resultStderr)
		lines.push(
			theme.fg("warning", `stderr   ${truncateText(step.resultStderr.replace(/\s+/g, " "), Math.max(0, width - 9))}`),
		)
	if (step.gradeRationale)
		lines.push(theme.fg("dim", `grade    ${truncateText(step.gradeRationale, Math.max(0, width - 9))}`))
	return lines.length > 0 ? lines : [theme.fg("dim", "no detail yet")]
}

function renderSteps(
	snapshot: PanelSnapshot,
	state: ProgressViewState,
	width: number,
	theme: Theme,
	maxRows: number,
): string[] {
	const phaseId = activePhaseId(snapshot, state)
	const phase = snapshot.phases.find((row) => row.id === phaseId)
	const steps = phaseId ? (snapshot.stepsByPhase.get(phaseId) ?? []) : []
	const selectedOffset = snapshot.phases.length
	const selectedStepIndex = state.selected - selectedOffset
	const lines: string[] = []
	const title = phase ? `phase ${String(phase.index).padStart(2, "0")} · ${phase.name}` : "steps"
	lines.push(theme.fg("accent", truncateText(title, width)))
	if (steps.length === 0) {
		lines.push(theme.fg("dim", "no steps planned yet"))
	} else {
		const doneCount = steps.filter((step) => step.status === "done" || step.status === "verified").length
		if (doneCount > 0) lines.push(theme.fg("dim", `▸ ${doneCount} done`))
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i]
			if (!step) continue
			const selected = selectedStepIndex === i
			const bullet = stepBulletChar(step.status)
			const elapsed = formatElapsed(step.startedAt, step.completedAt, snapshot.now)
			const grade = displayGrade(step.grade)
			const suffix = [elapsed, grade].filter(Boolean).join(" ")
			const labelWidth = Math.max(8, width - suffix.length - 6)
			const line = `${selected ? theme.fg("text", "›") : " "} ${bullet} ${truncateText(step.description, labelWidth)}${suffix ? `  ${suffix}` : ""}`
			lines.push(selected ? selectedLine(theme, line, width) : padText(line, width))
			if (selected && state.detailStepId === step.id) {
				for (const detail of renderStepDetail(step, width - 4, theme)) {
					lines.push(theme.fg("dim", `    ${truncateText(detail, width - 4)}`))
				}
			}
		}
	}
	return lines
		.slice(0, maxRows)
		.concat(Array.from({ length: Math.max(0, maxRows - lines.length) }, () => " ".repeat(width)))
}

export function renderProgressView(
	snapshot: PanelSnapshot | undefined,
	state: ProgressViewState,
	trace: FermentTrace,
	width: number,
	height: number,
	theme: Theme,
): string[] {
	const rows = Math.max(0, height)
	if (rows === 0) return []
	if (!snapshot) {
		return [theme.fg("dim", "no active ferment"), ...Array.from({ length: rows - 1 }, () => " ".repeat(width))]
	}

	const itemCount = progressItems(snapshot, state).length
	state.selected = Math.max(0, Math.min(Math.max(0, itemCount - 1), state.selected))
	if (!state.expandedPhaseId) state.expandedPhaseId = snapshot.activePhaseId ?? snapshot.phases[0]?.id

	const dividerLine = divider(theme, width)
	const traceRows = Math.max(3, Math.min(8, Math.floor(rows * 0.3)))
	const phaseRows = Math.max(3, Math.min(snapshot.phases.length, Math.floor(rows * 0.34)))
	const stepRows = Math.max(2, rows - phaseRows - traceRows - 2)

	const lines = [
		...renderPhaseRail(snapshot, state, width, theme, phaseRows),
		dividerLine,
		...renderSteps(snapshot, state, width, theme, stepRows),
		dividerLine,
		...trace.render(width, traceRows, theme),
	]
	return lines.slice(0, rows).concat(Array.from({ length: Math.max(0, rows - lines.length) }, () => " ".repeat(width)))
}
