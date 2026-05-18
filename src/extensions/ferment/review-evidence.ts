/**
 * Per-attempt review evidence + escalation artifacts.
 *
 * After every judgeReviewPhase call we persist a small JSON record describing
 * what was reviewed and what the verdict was. When block retries exhaust we
 * persist an escalation artifact the user can resolve from the CLI (or any
 * non-TUI surface).
 *
 * Layout (under the ferments dir):
 *
 *   ferments/
 *     {fermentId}.json                # ferment snapshot (existing)
 *     {fermentId}/                    # NEW review/escalation sidecar
 *       reviews/
 *         phase-{phaseId}-{attempt}.json
 *       escalations/
 *         phase-{phaseId}.json
 *
 * Best-effort: failure to write is logged via the optional `onError` callback
 * but never throws — verification flow continues even if disk is unwritable.
 *
 * Patterns lifted from GSD-2's verification-evidence.ts + escalation.ts,
 * scaled down to a single ferment context.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { resolveFermentsDir } from "../../ferment/store.js"
import type { JudgeFlag, ReviewOutcome } from "./judge.js"
import type { ProjectCheckResult } from "./project-tests.js"

/** Raw F-gate verdict the agent provided at complete_ferment_phase. Persisted on the
 *  review-evidence sidecar so the journey-grade judge can read it later. */
export interface PersistedGateVerdict {
	id: string
	verdict: string
	rationale: string
	evidence: string
}

export interface ReviewEvidence {
	schemaVersion: 1
	fermentId: string
	phaseId: string
	phaseName: string
	attempt: number
	timestamp: string

	/** Inputs the reviewer saw. */
	goal: string
	summary: string
	stepSummaries?: string
	diffAvailable: boolean
	diffFilesChanged?: string

	/** Outputs from the reviewer + deterministic checks. */
	flags: JudgeFlag[]
	derivedGrade: string
	reviewerRationale: string
	reviewerUnavailable?: boolean

	/** Raw F-gate verdicts the agent submitted at complete_ferment_phase. Optional for
	 *  back-compat with sidecars written before this field existed; new writes
	 *  always populate it. Consumed by the journey-grade judge at
	 *  complete_ferment to grade the journey end-to-end. */
	gateVerdicts?: PersistedGateVerdict[]

	projectChecks?: {
		discovered: boolean
		anyFailed: boolean
		commands: Array<{ kind: string; command: string; exitCode: number; durationMs: number; timedOut: boolean }>
	}
}

export interface EscalationArtifact {
	schemaVersion: 1
	fermentId: string
	phaseId: string
	phaseName: string
	timestamp: string
	question: string
	flags: JudgeFlag[]
	options: Array<{ id: string; label: string; recommendation?: boolean }>
	recommendation?: string
	recommendationRationale?: string
}

function fermentSidecarDir(fermentId: string, root?: string): string {
	const base = root ?? resolveFermentsDir()
	return resolve(base, fermentId)
}

function ensureDir(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

function safeWrite(path: string, body: string, onError?: (err: unknown) => void): void {
	try {
		writeFileSync(path, body, "utf-8")
	} catch (err) {
		onError?.(err)
	}
}

/** Write the per-attempt review-evidence JSON. Returns the path written, or
 *  undefined if write was skipped/failed. */
export function writeReviewEvidence(args: {
	fermentId: string
	phaseId: string
	phaseName: string
	attempt: number
	goal: string
	summary: string
	stepSummaries?: string
	outcome: ReviewOutcome
	diffFilesChanged?: string
	diffAvailable: boolean
	projectChecks?: ProjectCheckResult
	/** Raw F-gate verdicts the agent passed at complete_ferment_phase. Persisted so the
	 *  journey-grade judge at complete_ferment can grade based on the trail. */
	gateVerdicts?: ReadonlyArray<PersistedGateVerdict>
	root?: string
	onError?: (err: unknown) => void
}): string | undefined {
	const dir = resolve(fermentSidecarDir(args.fermentId, args.root), "reviews")
	try {
		ensureDir(dir)
	} catch (err) {
		args.onError?.(err)
		return undefined
	}
	const path = resolve(dir, `phase-${args.phaseId}-${args.attempt}.json`)
	const record: ReviewEvidence = {
		schemaVersion: 1,
		fermentId: args.fermentId,
		phaseId: args.phaseId,
		phaseName: args.phaseName,
		attempt: args.attempt,
		timestamp: new Date().toISOString(),
		goal: args.goal,
		summary: args.summary,
		stepSummaries: args.stepSummaries,
		diffAvailable: args.diffAvailable,
		diffFilesChanged: args.diffFilesChanged,
		flags: args.outcome.flags,
		derivedGrade: args.outcome.grade,
		reviewerRationale: args.outcome.rationale,
		reviewerUnavailable: args.outcome.unavailable,
		gateVerdicts: args.gateVerdicts ? [...args.gateVerdicts] : undefined,
		projectChecks: args.projectChecks
			? {
					discovered: args.projectChecks.discovered,
					anyFailed: args.projectChecks.anyFailed,
					commands: args.projectChecks.checks.map((c) => ({
						kind: c.kind,
						command: c.command,
						exitCode: c.exitCode,
						durationMs: c.durationMs,
						timedOut: c.timedOut,
					})),
				}
			: undefined,
	}
	safeWrite(path, `${JSON.stringify(record, null, 2)}\n`, args.onError)
	return path
}

/** Write an escalation artifact when block retries exhaust. Returns the path
 *  written, or undefined if disabled/failed. */
export function writeEscalationArtifact(args: {
	fermentId: string
	phaseId: string
	phaseName: string
	flags: JudgeFlag[]
	maxRetries: number
	root?: string
	onError?: (err: unknown) => void
}): string | undefined {
	const dir = resolve(fermentSidecarDir(args.fermentId, args.root), "escalations")
	try {
		ensureDir(dir)
	} catch (err) {
		args.onError?.(err)
		return undefined
	}
	const path = resolve(dir, `phase-${args.phaseId}.json`)
	const record: EscalationArtifact = {
		schemaVersion: 1,
		fermentId: args.fermentId,
		phaseId: args.phaseId,
		phaseName: args.phaseName,
		timestamp: new Date().toISOString(),
		question: `Reviewer still blocking phase "${args.phaseName}" after ${args.maxRetries} retries. How should we proceed?`,
		flags: args.flags,
		options: [
			{ id: "override", label: "Override and proceed (mark phase done)" },
			{ id: "pause", label: "Pause ferment for manual fix", recommendation: true },
			{ id: "abandon", label: "Abandon ferment" },
		],
		recommendation: "pause",
		recommendationRationale:
			"Pausing preserves the in-flight work and lets you inspect the actual code before deciding to override the reviewer or abandon.",
	}
	safeWrite(path, `${JSON.stringify(record, null, 2)}\n`, args.onError)
	return path
}

/** Read the highest-attempt review-evidence sidecar for each phase in the
 *  ferment. Used by the journey-grade judge at complete_ferment to assemble
 *  the per-phase verdict trail. Returns an empty map when the reviews/ dir is
 *  missing (legacy ferment) or unreadable (best-effort). */
export function readLatestPhaseReviews(fermentId: string, root?: string): Map<string, ReviewEvidence> {
	const reviewsDir = resolve(fermentSidecarDir(fermentId, root), "reviews")
	const result = new Map<string, ReviewEvidence>()
	if (!existsSync(reviewsDir)) return result

	let entries: string[]
	try {
		entries = readdirSync(reviewsDir)
	} catch {
		return result
	}

	// Files are named `phase-{phaseId}-{attempt}.json`. Group by phaseId,
	// keep the highest attempt. The filename pattern is sufficient — no need
	// to parse every file just to find the latest.
	const bestByPhase = new Map<string, { attempt: number; file: string }>()
	for (const file of entries) {
		const m = file.match(/^phase-(.+)-(\d+)\.json$/)
		if (!m) continue
		const phaseId = m[1]
		const attempt = Number.parseInt(m[2], 10)
		if (!Number.isFinite(attempt)) continue
		const prev = bestByPhase.get(phaseId)
		if (!prev || attempt > prev.attempt) bestByPhase.set(phaseId, { attempt, file })
	}

	for (const [phaseId, { file }] of bestByPhase) {
		try {
			const raw = readFileSync(resolve(reviewsDir, file), "utf-8")
			const parsed = JSON.parse(raw) as ReviewEvidence
			if (parsed?.schemaVersion === 1 && parsed?.phaseId === phaseId) {
				result.set(phaseId, parsed)
			}
		} catch {
			// Skip corrupt/missing entries — best-effort. The journey judge
			// will see "(no verdicts on file)" for this phase, which is
			// honest about the gap.
		}
	}
	return result
}

/** Stable, order-independent hash of a flag set. Used by the retry loop to
 *  detect "same broken state twice" without depending on flag ordering. */
export function hashFlags(flags: JudgeFlag[]): string {
	if (flags.length === 0) return ""
	const tuples = flags
		.map((f) => `${f.severity}|${f.problem.trim()}|${f.redirect.trim()}`)
		.sort()
		.join("\n")
	// Cheap FNV-1a hash — sufficient for "same string twice" detection.
	let h = 0x811c9dc5
	for (let i = 0; i < tuples.length; i++) {
		h ^= tuples.charCodeAt(i)
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
	}
	return h.toString(16)
}
