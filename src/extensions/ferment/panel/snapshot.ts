import type { FermentStats } from "../../../ferment/stats.js"
import { computeStats } from "../../../ferment/stats.js"
import type { Ferment, Phase, Step } from "../../../ferment/types.js"
import { decideContinuation } from "../continuation.js"
import type { FermentRuntime } from "../runtime.js"

export interface PanelPhaseRow {
	id: string
	index: number
	name: string
	status: Phase["status"]
	doneSteps: number
	totalSteps: number
	grade?: string
	parallel: boolean
	awaitingInput: boolean
	active: boolean
}

export interface PanelStepRow {
	id: string
	phaseId: string
	index: number
	description: string
	status: Step["status"]
	startedAt?: string
	completedAt?: string
	summary?: string
	verificationCommand?: string
	resultExitCode?: number
	resultStdout?: string
	resultStderr?: string
	grade?: string
	gradeRationale?: string
}

export interface PanelSnapshot {
	ferment: Ferment
	stats: FermentStats
	name: string
	status: Ferment["status"]
	branch?: string
	grade?: string
	activePhaseId?: string
	activePhaseIndex: number
	continuationPolicy: ReturnType<FermentRuntime["getContinuationPolicy"]>
	lastHumanInputAt?: string
	now: number
	phases: PanelPhaseRow[]
	stepsByPhase: Map<string, PanelStepRow[]>
}

function isStepDone(step: Step): boolean {
	return step.status === "done" || step.status === "verified" || step.status === "skipped"
}

function stepRow(phase: Phase, step: Step): PanelStepRow {
	return {
		id: step.id,
		phaseId: phase.id,
		index: step.index,
		description: step.description,
		status: step.status,
		startedAt: step.startedAt,
		completedAt: step.completedAt ?? step.result?.completedAt,
		summary: step.summary,
		verificationCommand: step.verification?.command,
		resultExitCode: step.result?.exitCode,
		resultStdout: step.result?.stdout,
		resultStderr: step.result?.stderr,
		grade: step.grade?.grade,
		gradeRationale: step.grade?.rationale,
	}
}

export function buildPanelSnapshot(
	ferment: Ferment,
	runtime: Pick<FermentRuntime, "getContinuationPolicy" | "getLastHumanInputAt">,
	now = Date.now(),
): PanelSnapshot {
	const continuationPolicy = runtime.getContinuationPolicy()
	const decision = decideContinuation(ferment, continuationPolicy)
	const awaitingPhaseId = decision.type === "wait_manual_boundary" ? decision.action.phaseId : undefined
	const lastHumanInputAt = runtime.getLastHumanInputAt()
	const activePhaseId = ferment.activePhaseId ?? ferment.phases.find((phase) => phase.status === "active")?.id
	const activePhaseIndex = Math.max(
		0,
		ferment.phases.findIndex((phase) => phase.id === activePhaseId),
	)
	const stepsByPhase = new Map<string, PanelStepRow[]>()

	const phases = ferment.phases.map((phase) => {
		const steps = phase.steps.map((step) => stepRow(phase, step))
		stepsByPhase.set(phase.id, steps)
		return {
			id: phase.id,
			index: phase.index,
			name: phase.name,
			status: phase.status,
			doneSteps: phase.steps.filter(isStepDone).length,
			totalSteps: phase.steps.length,
			grade: phase.grade?.grade,
			parallel: phase.parallel === true,
			awaitingInput: awaitingPhaseId === phase.id,
			active: phase.id === activePhaseId || phase.status === "active",
		}
	})

	return {
		ferment,
		stats: computeStats(ferment),
		name: ferment.name,
		status: ferment.status,
		branch: ferment.worktree.branch,
		grade: ferment.grade?.grade,
		activePhaseId,
		activePhaseIndex,
		continuationPolicy,
		lastHumanInputAt: lastHumanInputAt instanceof Date ? lastHumanInputAt.toISOString() : undefined,
		now,
		phases,
		stepsByPhase,
	}
}
