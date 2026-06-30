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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import {
	type PersistedRuntimeState,
	deleteRuntimeState,
	emptyState,
	loadRuntimeState,
	saveRuntimeState,
} from "./runtime-state-store.js"

// ─── Active ferment ───────────────────────────────────────────────────────────

let activeFerment: Ferment | undefined

export function getActive(): Ferment | undefined {
	return activeFerment
}

export function getActiveId(): string | undefined {
	return activeFerment?.id
}

export function getActiveFermentId(env: Record<string, string | undefined> = process.env): string | undefined {
	const id = env.KIMCHI_ACTIVE_FERMENT?.trim()
	return id || undefined
}

export function hasActiveFerment(env: Record<string, string | undefined> = process.env): boolean {
	return getActiveFermentId(env) !== undefined
}

export function clearActiveFermentId(env: Record<string, string | undefined> = process.env): void {
	Reflect.deleteProperty(env, "KIMCHI_ACTIVE_FERMENT")
}

let activeFermentChangeListener: ((hasActive: boolean) => void) | undefined

export function onActiveFermentChange(listener: (hasActive: boolean) => void): () => void {
	activeFermentChangeListener = listener
	return () => {
		if (activeFermentChangeListener === listener) activeFermentChangeListener = undefined
	}
}

export function notifyFermentActive(hasActive: boolean): void {
	activeFermentChangeListener?.(hasActive)
}

function shouldElevatePermissions(f: Ferment | undefined): boolean {
	return f?.status === "draft" || f?.status === "planned" || f?.status === "running" || f?.status === "paused"
}

export function setActive(f: Ferment | undefined): void {
	// If the active ferment is changing, manage lockfiles: write a lock for the
	// new active ferment, remove the lock for the old one. Best-effort — errors
	// are swallowed so they never block a state transition.
	if (activeFerment?.id && activeFerment.id !== f?.id) {
		removeFermentLock(activeFerment.id)
	}
	activeFerment = f
	const elevatePermissions = shouldElevatePermissions(f)
	if (elevatePermissions && f) {
		process.env.KIMCHI_ACTIVE_FERMENT = f.id
		writeFermentLock(f.id)
	} else {
		clearActiveFermentId()
		if (f?.id) removeFermentLock(f.id)
	}
	notifyFermentActive(elevatePermissions)
}

// ─── PID-based lockfiles ───────────────────────────────────────────────────────
//
// When a ferment is active in a session, a lockfile is written to a global
// directory. This allows `recoverStuckFerments()` in events.ts to distinguish
// between a genuinely crashed session (lockfile PID is dead or missing — safe
// to pause and recover) and a ferment actively running in another live kimchi
// session (lockfile PID is alive — do NOT pause).
//
// The lock directory is configurable via KIMCHI_FERMENT_LOCK_DIR for test
// isolation. By default it lives under ~/.config/kimchi/harness/ferment-locks/.

interface FermentLockInfo {
	pid: number
	startedAt: string
	fermentId: string
}

const SAFE_FERMENT_ID = /^[A-Za-z0-9._-]+$/

function getFermentLockDir(): string {
	const override = process.env.KIMCHI_FERMENT_LOCK_DIR?.trim()
	if (override) return override
	return join(homedir(), ".config", "kimchi", "harness", "ferment-locks")
}

export function getFermentLockPath(fermentId: string): string {
	if (!fermentId || !SAFE_FERMENT_ID.test(fermentId) || fermentId === "." || fermentId === "..") {
		throw new Error(`Invalid fermentId for lockfile: ${JSON.stringify(fermentId)}`)
	}
	return join(getFermentLockDir(), `${fermentId}.lock`)
}

/** Write a best-effort PID lockfile for the given ferment. Swallows all errors
 *  so it never blocks a state transition. */
export function writeFermentLock(fermentId: string): void {
	try {
		const lockDir = getFermentLockDir()
		mkdirSync(lockDir, { recursive: true })
		const lockInfo: FermentLockInfo = {
			pid: process.pid,
			startedAt: new Date().toISOString(),
			fermentId,
		}
		writeFileSync(getFermentLockPath(fermentId), JSON.stringify(lockInfo, null, 2), {
			encoding: "utf8",
			flag: "w",
		})
	} catch (err) {
		// Lockfile write failure is non-fatal — recovery will treat missing
		// locks as "not locked" and pause, which is the safe default. Log so
		// operators can detect when the cross-session protection is absent.
		console.error(`[ferment] failed to write lockfile for ${fermentId}:`, err)
	}
}

/** Remove the lockfile for the given ferment. Best-effort, swallows errors. */
export function removeFermentLock(fermentId: string): void {
	try {
		rmSync(getFermentLockPath(fermentId), { force: true })
	} catch (err) {
		// Non-fatal, but log so operators can detect lingering lockfiles.
		console.error(`[ferment] failed to remove lockfile for ${fermentId}:`, err)
	}
}

/** Default staleness ceiling for the PID-reuse guard (7 days). Generous enough
 *  that legitimate long-running sessions are unaffected; a ferment left active
 *  for longer than this is treated as abandoned and may be paused by recovery. */
const DEFAULT_LOCK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function getLockMaxAgeMs(): number {
	const raw = process.env.KIMCHI_FERMENT_LOCK_MAX_AGE_MS?.trim()
	if (!raw) return DEFAULT_LOCK_MAX_AGE_MS
	const n = Number(raw)
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOCK_MAX_AGE_MS
}

/** Check whether a ferment's lockfile points to a live (running) process.
 *
 *  Returns true if the lockfile exists, its `startedAt` is within the staleness
 *  window (see `KIMCHI_FERMENT_LOCK_MAX_AGE_MS`, default 7 days), and its PID is
 *  alive. Returns false if the lockfile is missing, unreadable, stale, has an
 *  invalid `startedAt`, or the PID is dead.
 *
 *  NOTE: `process.kill(pid, 0)` only proves that *some* process with that PID
 *  exists — it does NOT prove it is the original kimchi session. PIDs are
 *  recycled by the OS, so a crashed session whose PID is later reused by an
 *  unrelated process will be falsely reported as alive by the kernel check.
 *  The `startedAt` staleness guard above mitigates this by treating locks older
 *  than the configured max age as abandoned, but it cannot fully eliminate
 *  PID-reuse risk within that window. Operators relying on cross-session
 *  isolation should keep session lifetimes well below the max age. */
export function isFermentLockedByLiveProcess(fermentId: string): boolean {
	try {
		const lockPath = getFermentLockPath(fermentId)
		if (!existsSync(lockPath)) return false
		const raw = readFileSync(lockPath, "utf8")
		const lockInfo = JSON.parse(raw) as FermentLockInfo
		if (!lockInfo?.pid) return false
		// Staleness guard: if the lock predates the max session age, treat it
		// as stale even if the PID happens to be alive (PID-reuse mitigation).
		const startedAt = Date.parse(lockInfo.startedAt ?? "")
		if (!Number.isFinite(startedAt)) return false
		const now = Date.now()
		if (startedAt > now) return false // future timestamp → corrupt/stale
		if (now - startedAt > getLockMaxAgeMs()) return false
		// process.kill(pid, 0) throws if the process doesn't exist (or we lack
		// permission to signal it). A successful no-op return means it's alive.
		process.kill(lockInfo.pid, 0)
		return true
	} catch {
		return false
	}
}

// ─── Runtime continuation policy ──────────────────────────────────────────────

export type ContinuationPolicy = "manual" | "automated"

let continuationPolicy: ContinuationPolicy = "manual"

export function getContinuationPolicy(): ContinuationPolicy {
	return continuationPolicy
}

export function setContinuationPolicy(policy: ContinuationPolicy): void {
	continuationPolicy = policy
}

export function isAutomatedContinuationEnabled(): boolean {
	return continuationPolicy === "automated"
}

export function setAutomatedContinuationEnabled(v: boolean): void {
	continuationPolicy = v ? "automated" : "manual"
}

// ─── Last human input timestamp (used by the /ferment progress dialog title) ─

let lastHumanInputAt: Date | undefined

export function getLastHumanInputAt(): Date | undefined {
	return lastHumanInputAt
}

export function markHumanInput(): void {
	lastHumanInputAt = new Date()
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

	set(key: string, value: number): void {
		this.counts.set(key, value)
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

	entries(): IterableIterator<[string, number]> {
		return this.counts.entries()
	}
}

// ─── Stuck-loop detection (per-step counter) ──────────────────────────────────
// Key: `${fermentId}:${phaseId}:${stepId}`. Cleared on complete/skip/retry.

const stepStartCounts = new CounterMap()

export function bumpStepStart(fermentId: string, phaseId: string, stepId: string): number {
	hydrateIfNeeded(fermentId)
	const next = stepStartCounts.bump(`${fermentId}:${phaseId}:${stepId}`)
	persistFerment(fermentId)
	return next
}

export function clearStepStart(fermentId: string, phaseId: string, stepId: string): void {
	hydrateIfNeeded(fermentId)
	stepStartCounts.clear(`${fermentId}:${phaseId}:${stepId}`)
	persistFerment(fermentId)
}

export function clearAllStepStarts(): void {
	stepStartCounts.clearAll()
	// Also forget hydration markers so subsequent accesses re-read from
	// disk. Tests rely on this when isolating cases via persist-root swaps.
	hydratedFerments.clear()
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

// ─── Pending compaction requests (transient) ─────────────────────────────────
// Recorded on successful complete_ferment_step / complete_ferment_phase so the
// agent_end hook can auto-compact the session context. Cleared when the
// compaction fires. Not persisted — single-session handoff only.

export interface PendingCompaction {
	kind: "step" | "phase"
	fermentId: string
	phaseId: string
	stepId?: string
	completedAt: string
}

const pendingCompactions = new Map<string, PendingCompaction>()
/** Ferment IDs whose compaction is currently in-flight. Kept in state so it
 *  resets with clearFermentState and doesn't leak across test runtimes. */
const compactionInFlight = new Set<string>()

export function setPendingCompaction(fermentId: string, pending: PendingCompaction): void {
	pendingCompactions.set(fermentId, pending)
}

export function getPendingCompaction(fermentId: string): PendingCompaction | undefined {
	return pendingCompactions.get(fermentId)
}

export function clearPendingCompaction(fermentId: string): void {
	pendingCompactions.delete(fermentId)
}

/** Drain pending compactions that are NOT currently in-flight.
 *  Items for in-flight ferments are left in the map so the next
 *  turn_end / agent_end can retry them once the current compaction finishes. */
export function drainPendingCompactions(): PendingCompaction[] {
	const ready: PendingCompaction[] = []
	for (const [fermentId, pending] of pendingCompactions) {
		if (!compactionInFlight.has(fermentId)) {
			ready.push(pending)
			pendingCompactions.delete(fermentId)
		}
	}
	return ready
}

export function markCompactionInFlight(fermentId: string): void {
	compactionInFlight.add(fermentId)
}

export function clearCompactionInFlight(fermentId: string): void {
	compactionInFlight.delete(fermentId)
}

export function isCompactionInFlight(fermentId: string): boolean {
	return compactionInFlight.has(fermentId)
}

export function clearAllPendingCompactions(): void {
	pendingCompactions.clear()
	compactionInFlight.clear()
}

// ─── Mid-turn oneshot overrun warnings (per session) ─────────────────────────
// Tracks which one-shot ferments have already emitted a mid-turn context-overrun
// breadcrumb so we don't spam on every turn_end above threshold. Kept in state
// (not a module-level Set in auto-compaction.ts) so it is scoped to the runtime
// instance and resets with session_start.
const midTurnOneshotWarnings = new Set<string>()

export function markMidTurnOneshotWarning(fermentId: string): void {
	midTurnOneshotWarnings.add(fermentId)
}

export function hasMidTurnOneshotWarning(fermentId: string): boolean {
	return midTurnOneshotWarnings.has(fermentId)
}

export function clearMidTurnOneshotWarnings(): void {
	midTurnOneshotWarnings.clear()
}

// ─── Block-retry counter (per phase) ─────────────────────────────────────────
// Key: `${fermentId}:${phaseId}`. Incremented every time complete_ferment_phase is
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
	hydrateIfNeeded(fermentId)
	const next = blockRetryCounts.bump(`${fermentId}:${phaseId}`)
	persistFerment(fermentId)
	return next
}

export function getBlockRetry(fermentId: string, phaseId: string): number {
	hydrateIfNeeded(fermentId)
	return blockRetryCounts.get(`${fermentId}:${phaseId}`)
}

export function clearBlockRetry(fermentId: string, phaseId: string): void {
	hydrateIfNeeded(fermentId)
	blockRetryCounts.clear(`${fermentId}:${phaseId}`)
	lastBlockHash.delete(`${fermentId}:${phaseId}`)
	persistFerment(fermentId)
}

/** Record the block-flag signature for this phase. Returns true if the
 *  signature matches the previously-stored one — i.e., the agent failed to
 *  make progress against the same blocks twice in a row. */
export function recordBlockHashAndCheckRepeat(fermentId: string, phaseId: string, hash: string): boolean {
	hydrateIfNeeded(fermentId)
	const key = `${fermentId}:${phaseId}`
	const prev = lastBlockHash.get(key)
	lastBlockHash.set(key, hash)
	persistFerment(fermentId)
	return prev !== undefined && prev === hash
}

// ─── Step failure / completion counter (per step) ────────────────────────────
// Used as a deterministic trigger for invoking the judge at complete_ferment_step.
// Increments on every complete_ferment_step attempt (successful or not). The judge
// is asked to review only after a configurable threshold to keep token spend
// low when work is going smoothly.

const stepCompleteAttempts = new CounterMap()

export function bumpStepCompleteAttempt(fermentId: string, phaseId: string, stepId: string): number {
	hydrateIfNeeded(fermentId)
	const next = stepCompleteAttempts.bump(`${fermentId}:${phaseId}:${stepId}`)
	persistFerment(fermentId)
	return next
}

export function clearStepCompleteAttempt(fermentId: string, phaseId: string, stepId: string): void {
	hydrateIfNeeded(fermentId)
	stepCompleteAttempts.clear(`${fermentId}:${phaseId}:${stepId}`)
	persistFerment(fermentId)
}

// ─── Phase-start git ref cache ────────────────────────────────────────────────
// Captured at activate_ferment_phase, consumed at complete_ferment_phase so the gate-validation
// path can include diff evidence. Persisted to disk (see below) so the ref
// survives a CLI restart. If unavailable (not a git repo, etc.) callers fall
// back to summary-only handling.

const phaseStartRefs = new Map<string, string>()

export function setPhaseStartRef(fermentId: string, phaseId: string, ref: string): void {
	hydrateIfNeeded(fermentId)
	phaseStartRefs.set(`${fermentId}:${phaseId}`, ref)
	persistFerment(fermentId)
}

export function getPhaseStartRef(fermentId: string, phaseId: string): string | undefined {
	hydrateIfNeeded(fermentId)
	return phaseStartRefs.get(`${fermentId}:${phaseId}`)
}

// ─── Step-start git ref cache ────────────────────────────────────────────────
// Captured at start_ferment_step, consumed at complete_ferment_step / verify_ferment_step so the
// gate-evidence path can diff against the step's actual starting state instead
// of the phase's. Symmetric with phaseStartRefs and identical lifetime
// semantics (persisted, survives restart).

const stepStartRefs = new Map<string, string>()

export function setStepStartRef(fermentId: string, phaseId: string, stepId: string, ref: string): void {
	hydrateIfNeeded(fermentId)
	stepStartRefs.set(`${fermentId}:${phaseId}:${stepId}`, ref)
	persistFerment(fermentId)
}

export function getStepStartRef(fermentId: string, phaseId: string, stepId: string): string | undefined {
	hydrateIfNeeded(fermentId)
	return stepStartRefs.get(`${fermentId}:${phaseId}:${stepId}`)
}

// ─── Disk-backed persistence (write-through + lazy hydrate) ───────────────────
//
// The six stores above (stepStartCounts, blockRetryCounts, lastBlockHash,
// stepCompleteAttempts, phaseStartRefs, stepStartRefs) survive a CLI restart.
// The pattern:
//
//   1. First access by fermentId hydrates from disk into the in-memory maps.
//   2. Every mutation writes the full per-ferment snapshot to disk via
//      saveRuntimeState. Atomic (temp + rename); failures are logged but
//      never throw. The in-memory map is the source of truth during the
//      session, disk is the recovery surface.
//   3. clearFermentState deletes both in-memory entries and the disk file.
//
// scopingInteractive / scopingConfirmed are NOT persisted — they're
// single-session UI handoff state.

const hydratedFerments = new Set<string>()

/** Configurable persistence root, used by tests to redirect writes into a
 *  temp dir. When undefined, resolveFermentsDir() is used. */
let runtimeStatePersistRoot: string | undefined

export function setRuntimeStatePersistRoot(root: string | undefined): void {
	runtimeStatePersistRoot = root
	// Forget all hydration markers so subsequent reads re-hydrate from the
	// new root. Tests rely on this when swapping roots between cases.
	hydratedFerments.clear()
}

/** Build a snapshot of the six persisted stores for a single ferment by
 *  filtering the global maps by fermentId prefix. */
function snapshotForFerment(fermentId: string): PersistedRuntimeState {
	const prefix = `${fermentId}:`
	const snap = emptyState()
	const stripPrefix = (k: string): string => k.slice(prefix.length)

	for (const [k, v] of stepStartCounts.entries()) {
		if (k.startsWith(prefix)) snap.stepStartCounts[stripPrefix(k)] = v
	}
	for (const [k, v] of blockRetryCounts.entries()) {
		if (k.startsWith(prefix)) snap.blockRetries[stripPrefix(k)] = v
	}
	for (const [k, v] of lastBlockHash.entries()) {
		if (k.startsWith(prefix)) snap.lastBlockHashes[stripPrefix(k)] = v
	}
	for (const [k, v] of stepCompleteAttempts.entries()) {
		if (k.startsWith(prefix)) snap.stepCompleteAttempts[stripPrefix(k)] = v
	}
	for (const [k, v] of phaseStartRefs.entries()) {
		if (k.startsWith(prefix)) snap.phaseStartRefs[stripPrefix(k)] = v
	}
	for (const [k, v] of stepStartRefs.entries()) {
		if (k.startsWith(prefix)) snap.stepStartRefs[stripPrefix(k)] = v
	}
	return snap
}

/** Hydrate a ferment's persisted state into the in-memory maps. Idempotent —
 *  the second call is a no-op. Called lazily from every persisted accessor. */
function hydrateIfNeeded(fermentId: string): void {
	if (hydratedFerments.has(fermentId)) return
	hydratedFerments.add(fermentId)

	const state = loadRuntimeState(fermentId, runtimeStatePersistRoot)
	const prefix = `${fermentId}:`
	for (const [k, v] of Object.entries(state.stepStartCounts)) stepStartCounts.set(`${prefix}${k}`, v)
	for (const [k, v] of Object.entries(state.blockRetries)) blockRetryCounts.set(`${prefix}${k}`, v)
	for (const [k, v] of Object.entries(state.lastBlockHashes)) lastBlockHash.set(`${prefix}${k}`, v)
	for (const [k, v] of Object.entries(state.stepCompleteAttempts)) stepCompleteAttempts.set(`${prefix}${k}`, v)
	for (const [k, v] of Object.entries(state.phaseStartRefs)) phaseStartRefs.set(`${prefix}${k}`, v)
	for (const [k, v] of Object.entries(state.stepStartRefs)) stepStartRefs.set(`${prefix}${k}`, v)
}

/** Persist the current in-memory snapshot for a ferment. Best-effort. */
function persistFerment(fermentId: string): void {
	saveRuntimeState(fermentId, snapshotForFerment(fermentId), {
		root: runtimeStatePersistRoot,
		onError: (err) => {
			console.error(`[ferment] runtime-state persist failed for ${fermentId}:`, err)
		},
	})
}

// ─── Scoping exploration turn counter ─────────────────────────────────────────
// Tracks consecutive turns during draft scoping where the model only called
// read-like tools (read, grep, ls, find, bash, web_search, web_fetch, set_phase)
// without calling any scoping-progression tool (ask_user,
// confirm_ferment_completion_criteria, propose_ferment_scoping, scope_ferment, Agent).
// After MAX_SCOPING_EXPLORE_TURNS, the turn_end handler injects a nudge
// telling the model to stop exploring and advance to the next scoping step.
//
// Threshold is intentionally generous: thorough exploration is part of a good
// plan. Bench data shows ~3 productive exploration turns are normal before the
// model can write a well-grounded scope. We only want to catch the long-tail
// case where the model is genuinely stuck.

const scopingExploreTurns = new Map<string, number>()

export const MAX_SCOPING_EXPLORE_TURNS = 8

export function bumpScopingExploreTurns(fermentId: string): number {
	const next = (scopingExploreTurns.get(fermentId) ?? 0) + 1
	scopingExploreTurns.set(fermentId, next)
	return next
}

export function getScopingExploreTurns(fermentId: string): number {
	return scopingExploreTurns.get(fermentId) ?? 0
}

export function resetScopingExploreTurns(fermentId: string): void {
	scopingExploreTurns.delete(fermentId)
}

// ─── Per-ferment cleanup ──────────────────────────────────────────────────────

/** Clear all in-memory state scoped to a specific ferment. Called on abandon/delete/complete. */
export function clearFermentState(fermentId: string): void {
	scopingInteractive.delete(fermentId)
	scopingConfirmed.delete(fermentId)
	scopingExploreTurns.delete(fermentId)
	const prefix = `${fermentId}:`
	stepStartCounts.clearByPrefix(prefix)
	blockRetryCounts.clearByPrefix(prefix)
	stepCompleteAttempts.clearByPrefix(prefix)
	for (const key of lastBlockHash.keys()) {
		if (key.startsWith(prefix)) lastBlockHash.delete(key)
	}
	for (const key of phaseStartRefs.keys()) {
		if (key.startsWith(prefix)) phaseStartRefs.delete(key)
	}
	for (const key of stepStartRefs.keys()) {
		if (key.startsWith(prefix)) stepStartRefs.delete(key)
	}
	hydratedFerments.delete(fermentId)
	// Per-ferment compaction state: a pending request left in the map for a
	// completed/abandoned/deleted ferment will never be drained, and an
	// in-flight marker that outlives the ferment blocks future compactions
	// for the same id (key collisions are vanishingly unlikely but cheap to avoid).
	pendingCompactions.delete(fermentId)
	compactionInFlight.delete(fermentId)
	deleteRuntimeState(fermentId, runtimeStatePersistRoot)
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
