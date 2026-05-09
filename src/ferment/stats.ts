/**
 * Ferment computed stats — derived views over the Ferment snapshot.
 *
 * These types mirror the FermentStats interface defined in
 * docs/ferment-storage-schema.md.
 */

import type { Ferment, Grade, Phase, Step } from "./types.js"

// ─── Grade helpers ────────────────────────────────────────────────────────────

const GRADE_NUMBERS: Record<Grade, number> = {
	A: 4,
	B: 3,
	C: 2,
	D: 1,
	F: 0,
}

function gradeToNumber(grade: Grade): number {
	return GRADE_NUMBERS[grade]
}

/** Compute simple average of numeric grades, or undefined if no grades. */
function averageGrade(grades: Grade[]): number | undefined {
	if (grades.length === 0) return undefined
	const sum = grades.reduce((acc, g) => acc + gradeToNumber(g), 0)
	return sum / grades.length
}

// ─── Percentile helper ────────────────────────────────────────────────────────

/**
 * Compute the p-th percentile of a sorted array of numbers.
 * Returns undefined when the dataset is too small (< 2 points).
 */
function percentile(sortedValues: number[], p: number): number | undefined {
	if (sortedValues.length < 2) return undefined
	// Linear interpolation between closest ranks
	const rank = (p / 100) * (sortedValues.length - 1)
	const lower = Math.floor(rank)
	const upper = Math.ceil(rank)
	if (lower === upper) return sortedValues[lower]
	return sortedValues[lower] + (rank - lower) * (sortedValues[upper] - sortedValues[lower])
}

// ─── Stats interfaces ─────────────────────────────────────────────────────────

export interface StatsPhases {
	total: number
	completed: number
	skipped: number
	failed: number
	active: number
	planned: number
	averageGrade?: number
}

export interface StatsSteps {
	total: number
	done: number
	skipped: number
	failed: number
	running: number
	planned: number
	averageStepGrade?: number
}

export interface StatsTiming {
	totalDurationMs: number
	phaseDurationsMs: Record<string, number>
	stepDurationsMs: Record<string, number>
	averageStepDurationMs?: number
	p50StepDurationMs?: number
	p90StepDurationMs?: number
}

export interface StatsGrading {
	overallGrade?: Grade
	phaseGrades: Array<{ phaseId: string; grade: Grade }>
	stepGrades: Array<{ phaseId: string; stepId: string; grade: Grade }>
}

export interface StatsWorkers {
	modelsUsed: Array<{ model: string; count: number }>
	totalParallelSteps: number
}

export interface StatsDecisions {
	total: number
	byPhase: Record<string, number>
}

export interface StatsMemories {
	total: number
	byCategory: Record<string, number>
}

export interface FermentStats {
	fermentId: string
	phases: StatsPhases
	steps: StatsSteps
	timing: StatsTiming
	grading: StatsGrading
	workers: StatsWorkers
	decisions: StatsDecisions
	memories: StatsMemories
}

// ─── Duration helpers ─────────────────────────────────────────────────────────

function parseDate(iso: string): number {
	return new Date(iso).getTime()
}

function phaseDuration(phase: Phase): number | null {
	if (!phase.startedAt) return null
	const start = parseDate(phase.startedAt)
	const end = phase.completedAt ? parseDate(phase.completedAt) : Date.now()
	return end - start
}

function stepDuration(step: Step): number | null {
	if (!step.startedAt) return null
	const start = parseDate(step.startedAt)
	const end = step.completedAt ? parseDate(step.completedAt) : Date.now()
	return end - start
}

// ─── Main compute function ────────────────────────────────────────────────────

/**
 * Compute a `FermentStats` view from a `Ferment` snapshot.
 * All values are derived from the snapshot — no event log required.
 */
export function computeStats(ferment: Ferment): FermentStats {
	// ── Phases ────────────────────────────────────────────────────────────────
	let phaseTotal = 0
	let phaseCompleted = 0
	let phaseSkipped = 0
	let phaseFailed = 0
	let phaseActive = 0
	let phasePlanned = 0
	const phaseGradeList: Grade[] = []
	const phaseDurationsMs: Record<string, number> = {}

	for (const phase of ferment.phases) {
		phaseTotal++
		switch (phase.status) {
			case "completed":
				phaseCompleted++
				break
			case "skipped":
				phaseSkipped++
				break
			case "failed":
				phaseFailed++
				break
			case "active":
				phaseActive++
				break
			case "planned":
				phasePlanned++
				break
		}

		// Skip unavailable judge grades (judge was unreachable / output unparseable)
		// — they carry a synthetic "B" placeholder that would otherwise inflate
		// average grades and mask real outages.
		if (phase.grade && !phase.grade.unavailable) {
			phaseGradeList.push(phase.grade.grade)
		}

		const dur = phaseDuration(phase)
		if (dur !== null) {
			phaseDurationsMs[phase.id] = dur
		}
	}

	// ── Steps ─────────────────────────────────────────────────────────────────
	let stepTotal = 0
	let stepDone = 0
	let stepSkipped = 0
	let stepFailed = 0
	let stepRunning = 0
	let stepPlanned = 0
	const stepGradeList: Grade[] = []
	const stepDurationsMs: Record<string, number> = {}
	const workerModelCounts: Record<string, number> = {}
	let totalParallelSteps = 0

	for (const phase of ferment.phases) {
		for (const step of phase.steps) {
			stepTotal++
			switch (step.status) {
				case "done":
				case "verified":
					stepDone++
					break
				case "skipped":
					stepSkipped++
					break
				case "failed":
					stepFailed++
					break
				case "running":
					stepRunning++
					break
				case "pending":
					stepPlanned++
					break
			}

			if (step.grade && !step.grade.unavailable) {
				stepGradeList.push(step.grade.grade)
			}

			const dur = stepDuration(step)
			if (dur !== null) {
				stepDurationsMs[step.id] = dur
			}

			if (step.workerModel) {
				workerModelCounts[step.workerModel] = (workerModelCounts[step.workerModel] ?? 0) + 1
			}

			if (step.canRunParallel) {
				totalParallelSteps++
			}
		}
	}

	// ── Timing ─────────────────────────────────────────────────────────────────
	const now = Date.now()
	// Use lastActiveAt as the end anchor when ferment is done; otherwise use now.
	const endAnchor =
		ferment.status === "complete" || ferment.status === "abandoned"
			? (ferment.lastActiveAt ?? ferment.updatedAt)
			: new Date(now).toISOString()
	const totalDurationMs = parseDate(endAnchor) - parseDate(ferment.createdAt)

	const stepDurationValues = Object.values(stepDurationsMs)
	const averageStepDurationMs =
		stepDurationValues.length > 0
			? stepDurationValues.reduce((a, b) => a + b, 0) / stepDurationValues.length
			: undefined

	const sortedDurations = [...stepDurationValues].sort((a, b) => a - b)
	const p50StepDurationMs = percentile(sortedDurations, 50)
	const p90StepDurationMs = percentile(sortedDurations, 90)

	// ── Grading ────────────────────────────────────────────────────────────────
	const phaseGrades: Array<{ phaseId: string; grade: Grade }> = []
	for (const phase of ferment.phases) {
		if (phase.grade) {
			phaseGrades.push({ phaseId: phase.id, grade: phase.grade.grade })
		}
	}

	const stepGrades: Array<{ phaseId: string; stepId: string; grade: Grade }> = []
	for (const phase of ferment.phases) {
		for (const step of phase.steps) {
			if (step.grade) {
				stepGrades.push({ phaseId: phase.id, stepId: step.id, grade: step.grade.grade })
			}
		}
	}

	// ── Workers ────────────────────────────────────────────────────────────────
	const modelsUsed = Object.entries(workerModelCounts)
		.map(([model, count]) => ({ model, count }))
		.sort((a, b) => b.count - a.count)

	// ── Decisions ──────────────────────────────────────────────────────────────
	const decisionsByPhase: Record<string, number> = {}
	for (const decision of ferment.decisions) {
		if (decision.phaseId) {
			decisionsByPhase[decision.phaseId] = (decisionsByPhase[decision.phaseId] ?? 0) + 1
		}
	}

	// ── Memories ───────────────────────────────────────────────────────────────
	const memoriesByCategory: Record<string, number> = {}
	for (const memory of ferment.memories) {
		memoriesByCategory[memory.category] = (memoriesByCategory[memory.category] ?? 0) + 1
	}

	// ── Assemble ───────────────────────────────────────────────────────────────
	return {
		fermentId: ferment.id,
		phases: {
			total: phaseTotal,
			completed: phaseCompleted,
			skipped: phaseSkipped,
			failed: phaseFailed,
			active: phaseActive,
			planned: phasePlanned,
			averageGrade: averageGrade(phaseGradeList),
		},
		steps: {
			total: stepTotal,
			done: stepDone,
			skipped: stepSkipped,
			failed: stepFailed,
			running: stepRunning,
			planned: stepPlanned,
			averageStepGrade: averageGrade(stepGradeList),
		},
		timing: {
			totalDurationMs,
			phaseDurationsMs,
			stepDurationsMs,
			averageStepDurationMs,
			p50StepDurationMs,
			p90StepDurationMs,
		},
		grading: {
			overallGrade: ferment.grade?.grade,
			phaseGrades,
			stepGrades,
		},
		workers: {
			modelsUsed,
			totalParallelSteps,
		},
		decisions: {
			total: ferment.decisions.length,
			byPhase: decisionsByPhase,
		},
		memories: {
			total: ferment.memories.length,
			byCategory: memoriesByCategory,
		},
	}
}

/**
 * Serialize a `FermentStats` object to a JSON string with sorted keys
 * for deterministic output.
 */
export function serializeStats(stats: FermentStats): string {
	return JSON.stringify(stats, null, 2)
}
