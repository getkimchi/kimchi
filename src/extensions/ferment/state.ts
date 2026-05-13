/**
 * Ferment shared module state.
 *
 * All ferment files import from here for cross-cutting state — the active
 * ferment, scoping gates, stuck-loop counters, judge model handles, etc.
 *
 * State is intentionally module-scoped (not class-scoped) because the ferment
 * extension is a singleton: there's exactly one active session, one TUI, one
 * judge connection. Encapsulating in a class would add ceremony without value.
 */

import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import { notifyFermentActive } from "../permissions/index.js"

// ─── Active ferment ───────────────────────────────────────────────────────────

let activeFermentId: string | undefined
let activeFerment: Ferment | undefined

export function getActive(): Ferment | undefined {
	return activeFerment
}

export function getActiveId(): string | undefined {
	return activeFermentId
}

export function setActive(f: Ferment | undefined): void {
	activeFerment = f
	activeFermentId = f?.id
	const isResumable = f !== undefined && f.status !== "complete" && f.status !== "abandoned"
	if (isResumable) {
		process.env.KIMCHI_ACTIVE_FERMENT = f.id
	} else {
		Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")
	}
	notifyFermentActive(isResumable)
}

// ─── Auto-mode toggle (set by /pause and /auto commands) ──────────────────────

let autoModeEnabled = true

export function isAutoModeEnabled(): boolean {
	return autoModeEnabled
}

export function setAutoModeEnabled(v: boolean): void {
	autoModeEnabled = v
}

// ─── Last human input timestamp (used by the /progress dialog title) ─────────

let lastHumanInputAt: Date | undefined

export function getLastHumanInputAt(): Date | undefined {
	return lastHumanInputAt
}

export function markHumanInput(): void {
	lastHumanInputAt = new Date()
}

// ─── Model-switch suppression ─────────────────────────────────────────────────
// Used by model_select handler to prevent infinite recursion when reverting.

let restoringModel = false

export function isRestoringModel(): boolean {
	return restoringModel
}

export function setRestoringModel(v: boolean): void {
	restoringModel = v
}

// ─── Judge model handles (captured opportunistically from ctx) ────────────────

let judgeModel: Model<Api> | undefined
let judgeModelRegistry: ModelRegistry | undefined

export function getJudgeModel(): Model<Api> | undefined {
	return judgeModel
}

export function getJudgeModelRegistry(): ModelRegistry | undefined {
	return judgeModelRegistry
}

export function captureJudgeContext(model?: Model<Api>, registry?: ModelRegistry): void {
	if (model) judgeModel = model
	if (registry) judgeModelRegistry = registry
}

// ─── Counter abstraction ──────────────────────────────────────────────────────
//
// We track several per-key integer counters (step starts, step completes,
// block retries). Each shares the same key-prefix lifecycle: bumped during a
// turn, cleared on transition, swept by fermentId on cleanup. This helper
// removes the boilerplate; the named exports below are thin wrappers so call
// sites stay descriptive.

class CounterMap {
	private readonly counts = new Map<string, number>()

	bump(key: string): number {
		const next = (this.counts.get(key) ?? 0) + 1
		this.counts.set(key, next)
		return next
	}

	get(key: string): number {
		return this.counts.get(key) ?? 0
	}

	clear(key: string): void {
		this.counts.delete(key)
	}

	clearAll(): void {
		this.counts.clear()
	}

	clearByPrefix(prefix: string): void {
		for (const k of this.counts.keys()) {
			if (k.startsWith(prefix)) this.counts.delete(k)
		}
	}
}

// ─── Stuck-loop detection (per-step counter) ──────────────────────────────────
// Key: `${fermentId}:${phaseId}:${stepId}`. Cleared on complete/skip/retry.

const stepStartCounts = new CounterMap()

export function bumpStepStart(fermentId: string, phaseId: string, stepId: string): number {
	return stepStartCounts.bump(`${fermentId}:${phaseId}:${stepId}`)
}

export function clearStepStart(fermentId: string, phaseId: string, stepId: string): void {
	stepStartCounts.clear(`${fermentId}:${phaseId}:${stepId}`)
}

export function clearAllStepStarts(): void {
	stepStartCounts.clearAll()
}

// ─── Scoping gate ─────────────────────────────────────────────────────────────
// `scopingInteractive`: ferment IDs whose scoping is via TUI — the gate is enforced.
// `scopingConfirmed`:  ferment IDs where the user confirmed via TUI dropdown.

const scopingInteractive = new Set<string>()
const scopingConfirmed = new Set<string>()
const afterScopeContinuations = new Set<string>()

export function markScopingInteractive(fermentId: string): void {
	scopingInteractive.add(fermentId)
}

export function isScopingInteractive(fermentId: string): boolean {
	return scopingInteractive.has(fermentId)
}

export function markScopingConfirmed(fermentId: string): void {
	scopingConfirmed.add(fermentId)
}

export function isScopingConfirmed(fermentId: string): boolean {
	return scopingConfirmed.has(fermentId)
}

export function consumeScopingGate(fermentId: string): void {
	scopingInteractive.delete(fermentId)
	scopingConfirmed.delete(fermentId)
}

export function clearAllScopingGates(): void {
	scopingInteractive.clear()
	scopingConfirmed.clear()
}

// ─── Post-scope continuation handoff ─────────────────────────────────────────
// In plan mode, the after-scope transition needs a one-time user handoff: the
// plan was accepted inside a tool call, and the next step is a user decision.

export function markAfterScopeContinuation(fermentId: string): void {
	afterScopeContinuations.add(fermentId)
}

export function hasAfterScopeContinuation(fermentId: string): boolean {
	return afterScopeContinuations.has(fermentId)
}

export function consumeAfterScopeContinuation(fermentId: string): boolean {
	const hadContinuation = afterScopeContinuations.has(fermentId)
	afterScopeContinuations.delete(fermentId)
	return hadContinuation
}

export function clearAllAfterScopeContinuations(): void {
	afterScopeContinuations.clear()
}

// ─── Self-improvement: corrective step cache ──────────────────────────────────
// Key: `${fermentId}:${completedPhaseId}` — set by complete_phase when the
// reviewer emits a block flag, consumed by the planner system-prompt builder
// before the next phase. The cache holds the actionable redirect text so it's
// not re-fetched on every system-prompt rebuild.

const correctiveSteps = new Map<string, string>()

export function setCorrectiveStep(fermentId: string, phaseId: string, step: string): void {
	correctiveSteps.set(`${fermentId}:${phaseId}`, step)
}

export function getCorrectiveStep(fermentId: string, phaseId: string): string | undefined {
	return correctiveSteps.get(`${fermentId}:${phaseId}`)
}

// ─── Block-retry counter (per phase) ─────────────────────────────────────────
// Key: `${fermentId}:${phaseId}`. Incremented every time complete_phase is
// called and the reviewer emits at least one `block` flag. After
// MAX_BLOCK_RETRIES the harness escalates to a user-permission prompt.
//
// Failure-hash cache: per-phase, store the signature of the last block-flag
// set the reviewer raised. If the SAME set repeats, the self-heal loop is
// stuck — we short-circuit retries and escalate immediately. This is the
// "same broken state twice → don't waste turns" pattern from GSD-2's
// verification-retry-policy.

const blockRetryCounts = new CounterMap()
const lastBlockHash = new Map<string, string>()

export const MAX_BLOCK_RETRIES = 3

export function bumpBlockRetry(fermentId: string, phaseId: string): number {
	return blockRetryCounts.bump(`${fermentId}:${phaseId}`)
}

export function getBlockRetry(fermentId: string, phaseId: string): number {
	return blockRetryCounts.get(`${fermentId}:${phaseId}`)
}

export function clearBlockRetry(fermentId: string, phaseId: string): void {
	blockRetryCounts.clear(`${fermentId}:${phaseId}`)
	lastBlockHash.delete(`${fermentId}:${phaseId}`)
}

/** Record the block-flag signature for this phase. Returns true if the
 *  signature matches the previously-stored one — i.e., the agent failed to
 *  make progress against the same blocks twice in a row. */
export function recordBlockHashAndCheckRepeat(fermentId: string, phaseId: string, hash: string): boolean {
	const key = `${fermentId}:${phaseId}`
	const prev = lastBlockHash.get(key)
	lastBlockHash.set(key, hash)
	return prev !== undefined && prev === hash
}

// ─── Step failure / completion counter (per step) ────────────────────────────
// Used as a deterministic trigger for invoking the judge at complete_step.
// Increments on every complete_step attempt (successful or not). The judge
// is asked to review only after a configurable threshold to keep token spend
// low when work is going smoothly.

const stepCompleteAttempts = new CounterMap()

export function bumpStepCompleteAttempt(fermentId: string, phaseId: string, stepId: string): number {
	return stepCompleteAttempts.bump(`${fermentId}:${phaseId}:${stepId}`)
}

export function clearStepCompleteAttempt(fermentId: string, phaseId: string, stepId: string): void {
	stepCompleteAttempts.clear(`${fermentId}:${phaseId}:${stepId}`)
}

// ─── Phase-start git ref cache ────────────────────────────────────────────────
// Captured at activate_phase, consumed at complete_phase by the judge so it can
// diff against the phase's actual starting state. Not persisted — recomputed on
// each session resume. If unavailable (not a git repo, etc.) the judge falls
// back to summary-only grading.

const phaseStartRefs = new Map<string, string>()

export function setPhaseStartRef(fermentId: string, phaseId: string, ref: string): void {
	phaseStartRefs.set(`${fermentId}:${phaseId}`, ref)
}

export function getPhaseStartRef(fermentId: string, phaseId: string): string | undefined {
	return phaseStartRefs.get(`${fermentId}:${phaseId}`)
}

// ─── Step-start git ref cache ────────────────────────────────────────────────
// Captured at start_step, consumed at complete_step / verify_step so the step
// grader can diff against the step's actual starting state instead of the
// phase's. Symmetric with phaseStartRefs and identical lifetime semantics.

const stepStartRefs = new Map<string, string>()

export function setStepStartRef(fermentId: string, phaseId: string, stepId: string, ref: string): void {
	stepStartRefs.set(`${fermentId}:${phaseId}:${stepId}`, ref)
}

export function getStepStartRef(fermentId: string, phaseId: string, stepId: string): string | undefined {
	return stepStartRefs.get(`${fermentId}:${phaseId}:${stepId}`)
}

// ─── Per-ferment cleanup ──────────────────────────────────────────────────────

/** Clear all in-memory state scoped to a specific ferment. Called on abandon/delete/complete. */
export function clearFermentState(fermentId: string): void {
	scopingInteractive.delete(fermentId)
	scopingConfirmed.delete(fermentId)
	afterScopeContinuations.delete(fermentId)
	const prefix = `${fermentId}:`
	stepStartCounts.clearByPrefix(prefix)
	blockRetryCounts.clearByPrefix(prefix)
	stepCompleteAttempts.clearByPrefix(prefix)
	for (const key of lastBlockHash.keys()) {
		if (key.startsWith(prefix)) lastBlockHash.delete(key)
	}
	for (const key of correctiveSteps.keys()) {
		if (key.startsWith(prefix)) correctiveSteps.delete(key)
	}
	for (const key of phaseStartRefs.keys()) {
		if (key.startsWith(prefix)) phaseStartRefs.delete(key)
	}
	for (const key of stepStartRefs.keys()) {
		if (key.startsWith(prefix)) stepStartRefs.delete(key)
	}
}

// ─── Storage handle ───────────────────────────────────────────────────────────

/** Returns a FermentEventStore wrapping FermentStorage. All callers use this singleton.
 *  FermentEventStore is backward-compatible with FermentStorage — same API surface, adds
 *  append-only event logging for new mutations and transparently falls back to snapshot
 *  reads for legacy ferments.
 */
export function getStorage(): FermentEventStore {
	return new FermentEventStore()
}
