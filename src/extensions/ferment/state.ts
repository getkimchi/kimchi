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
import { FermentStorage } from "../../ferment/store.js"
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
	process.env.KIMCHI_ACTIVE_FERMENT = f?.id
	notifyFermentActive(f !== undefined)
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

// ─── Stuck-loop detection (per-step counter) ──────────────────────────────────
// Key: `${fermentId}:${phaseId}:${stepId}`. Cleared on complete/skip/retry.

const stepStartCounts = new Map<string, number>()

export function bumpStepStart(fermentId: string, phaseId: string, stepId: string): number {
	const key = `${fermentId}:${phaseId}:${stepId}`
	const next = (stepStartCounts.get(key) ?? 0) + 1
	stepStartCounts.set(key, next)
	return next
}

export function clearStepStart(fermentId: string, phaseId: string, stepId: string): void {
	stepStartCounts.delete(`${fermentId}:${phaseId}:${stepId}`)
}

export function clearAllStepStarts(): void {
	stepStartCounts.clear()
}

// ─── Scoping gate ─────────────────────────────────────────────────────────────
// `scopingInteractive`: ferment IDs whose scoping is via TUI — the gate is enforced.
// `scopingConfirmed`:  ferment IDs where the user confirmed via TUI dropdown.

const scopingInteractive = new Set<string>()
const scopingConfirmed = new Set<string>()

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

// ─── Per-ferment cleanup ──────────────────────────────────────────────────────

/** Clear all in-memory state scoped to a specific ferment. Called on abandon/delete/complete. */
export function clearFermentState(fermentId: string): void {
	scopingInteractive.delete(fermentId)
	scopingConfirmed.delete(fermentId)
	for (const key of stepStartCounts.keys()) {
		if (key.startsWith(`${fermentId}:`)) stepStartCounts.delete(key)
	}
}

// ─── Storage handle ───────────────────────────────────────────────────────────

export function getStorage(): FermentStorage {
	return new FermentStorage()
}
