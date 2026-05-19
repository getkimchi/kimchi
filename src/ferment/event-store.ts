/**
 * FermentEventStore — append-only event log layered over FermentStorage snapshots.
 *
 * - Snapshot layer: FermentStorage (unchanged, same file layout)
 * - Event log:       <baseDir>/<id>.events.jsonl — one JSON object per line
 * - Dual write:      every mutation goes to snapshot first, then event appended
 * - Read:            if `.events.jsonl` exists and is newer than snapshot, fold
 *                    events to reconstruct; otherwise delegate to snapshot
 * - Migration:       `migrateLegacy(id)` synthesises events from a legacy snapshot
 */

import { createHash } from "node:crypto"
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { resolve } from "node:path"
import { lockSync, unlockSync } from "proper-lockfile"
import { v7 as uuidv7 } from "uuid"

import { activateSinglePhase, settleAfterPhaseTerminal } from "./lifecycle.js"
import { FermentStorage, resolveFermentsDir } from "./store.js"
import type {
	Decision,
	Ferment,
	FermentWorkMode,
	JudgeGrade,
	Memory,
	MemoryCategory,
	Phase,
	Scoping,
	Step,
	StepResult,
} from "./types.js"

// ─── Deterministic state hash ─────────────────────────────────────────────────

/** Simple deterministic hash of a serialisable value. */
export function stateHash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalizeForHash(value)))
		.digest("hex")
		.slice(0, 16)
}

function canonicalizeForHash(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeForHash)
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(value).sort()) {
			if (key === "mode") continue
			const v = (value as Record<string, unknown>)[key]
			if (v !== undefined) out[key] = canonicalizeForHash(v)
		}
		return out
	}
	return value
}

// ─── Event types ──────────────────────────────────────────────────────────────

export type FermentEventType =
	| "ferment_created"
	| "scoping_goal_set"
	| "scoping_criteria_set"
	| "scoping_constraints_set"
	| "scoping_phases_set"
	| "scoping_assumptions_set"
	| "ferment_planned"
	| "ferment_running"
	| "ferment_paused"
	| "ferment_resumed"
	| "ferment_completed"
	| "ferment_renamed"
	| "ferment_mode_set"
	| "phase_activated"
	| "phase_group_activated"
	| "phase_completed"
	| "phase_skipped"
	| "phase_failed"
	| "phase_refined"
	| "phase_graded"
	| "step_started"
	| "step_completed"
	| "step_skipped"
	| "step_failed"
	| "step_verified"
	| "step_graded"
	| "step_description_updated"
	| "ferment_graded"
	| "decision_added"
	| "memory_added"
	| "worktree_updated"
	| "ferment_abandoned"
	// Legacy event types — read-only, retained so old logs can still be folded.
	| "ferment_scoped"

export interface FermentEventBase {
	id: string
	timestamp: string
	type: FermentEventType
	preStateHash: string
	postStateHash: string
}

export interface FermentCreatedPayload {
	id: string
	name: string
	description?: string
	/** @deprecated Legacy event logs may carry this, but fold ignores it. */
	mode?: FermentWorkMode
	/** Initial worktree captured by `FermentStorage.create()`. Folded back into the
	 *  reconstructed ferment so the event log produces the same state as the
	 *  snapshot — without this, fold leaves worktree at `{ path: "" }` while the
	 *  snapshot has the real path/branch/commit, breaking hash chain equivalence. */
	worktree?: Ferment["worktree"]
	createdAt?: string
}

/** @deprecated Replaced by scoping_*_set + ferment_planned events. Retained for legacy log fold. */
export interface FermentScopedPayload {
	scoping: Scoping
}

export interface ScopingGoalSetPayload {
	goal: NonNullable<Scoping["goal"]>
	/** Denormalized top-level Ferment.goal field (a plain string copy of the
	 *  answer). The state machine writes both Ferment.goal AND Ferment.scoping.goal,
	 *  so the fold needs both to reproduce the snapshot. Optional to keep legacy
	 *  events parseable. */
	plain?: string
}

export interface ScopingCriteriaSetPayload {
	criteria: NonNullable<Scoping["criteria"]>
	plain?: string
}

export interface ScopingConstraintsSetPayload {
	constraints: NonNullable<Scoping["constraints"]>
	/** Denormalized top-level Ferment.constraints field (string[]). */
	plain?: string[]
}

export interface ScopingPhasesSetPayload {
	phases: NonNullable<Scoping["phases"]>
	/** Snapshot of post.phases when scope was applied — needed during fold to reconstruct
	 *  the structural Phase[] array (the `Scoping` record only holds the answer text). */
	phaseSnapshots: Phase[]
}

export interface ScopingAssumptionsSetPayload {
	assumptions: NonNullable<Scoping["assumptions"]>
}

/** Status-transition events carry no payload data — pre/postStateHash captures the change. */
export type FermentPlannedPayload = Record<string, never>

export type FermentRunningPayload = Record<string, never>

export type FermentPausedPayload = Record<string, never>

export type FermentResumedPayload = Record<string, never>

export interface FermentCompletedPayload {
	finalSummary?: string
	completedAt: string
}

export interface FermentRenamedPayload {
	name: string
}

export interface FermentModeSetPayload {
	mode: FermentWorkMode
}

export interface PhaseActivatedPayload {
	phaseId: string
	startedAt: string
	groupIndex?: number
}

/**
 * Atomic activation of every phase in a parallel group.
 *
 * Emitted instead of N independent `phase_activated` events when the
 * state machine activates a `parallel_group`. The fold handler activates
 * every listed phaseId simultaneously, so replay reproduces the
 * "multiple phases active at once" snapshot — replaying N independent
 * activations would deactivate each previously-active sibling in turn.
 */
export interface PhaseGroupActivatedPayload {
	groupIndex: number
	phaseIds: string[]
	startedAt: string
}

export interface PhaseCompletedPayload {
	phaseId: string
	summary: string
	completedAt: string
}

export interface PhaseSkippedPayload {
	phaseId: string
	reason?: string
	completedAt: string
}

export interface PhaseFailedPayload {
	phaseId: string
	reason: string
	completedAt: string
}

export interface PhaseRefinedPayload {
	phaseId: string
	steps: Step[]
}

export interface PhaseGradedPayload {
	phaseId: string
	grade: JudgeGrade
}

export interface StepStartedPayload {
	phaseId: string
	stepId: string
	startedAt: string
}

export interface StepCompletedPayload {
	phaseId: string
	stepId: string
	completedAt: string
}

export interface StepSkippedPayload {
	phaseId: string
	stepId: string
	completedAt: string
}

export interface StepFailedPayload {
	phaseId: string
	stepId: string
	error?: string
	completedAt: string
}

export interface StepVerifiedPayload {
	phaseId: string
	stepId: string
	result: StepResult
	verifiedAt: string
	exitCode?: number
}

export interface StepGradedPayload {
	phaseId: string
	stepId: string
	grade: JudgeGrade
	gradedAt: string
}

export interface StepDescriptionUpdatedPayload {
	phaseId: string
	stepId: string
	description: string
}

export interface FermentGradedPayload {
	grade: JudgeGrade
}

export interface DecisionAddedPayload {
	decision: Decision
}

export interface MemoryAddedPayload {
	memory: Memory
}

export interface WorktreeUpdatedPayload {
	worktree: Ferment["worktree"]
}

export interface FermentAbandonedPayload {
	reason?: string
}

export type FermentCreatedEvent = FermentEventBase & { type: "ferment_created"; payload: FermentCreatedPayload }
/** @deprecated Replaced by scoping_*_set events. Read-only for legacy logs. */
export type FermentScopedEvent = FermentEventBase & { type: "ferment_scoped"; payload: FermentScopedPayload }
export type ScopingGoalSetEvent = FermentEventBase & { type: "scoping_goal_set"; payload: ScopingGoalSetPayload }
export type ScopingCriteriaSetEvent = FermentEventBase & {
	type: "scoping_criteria_set"
	payload: ScopingCriteriaSetPayload
}
export type ScopingConstraintsSetEvent = FermentEventBase & {
	type: "scoping_constraints_set"
	payload: ScopingConstraintsSetPayload
}
export type ScopingPhasesSetEvent = FermentEventBase & {
	type: "scoping_phases_set"
	payload: ScopingPhasesSetPayload
}
export type ScopingAssumptionsSetEvent = FermentEventBase & {
	type: "scoping_assumptions_set"
	payload: ScopingAssumptionsSetPayload
}
export type FermentPlannedEvent = FermentEventBase & { type: "ferment_planned"; payload: FermentPlannedPayload }
export type FermentRunningEvent = FermentEventBase & { type: "ferment_running"; payload: FermentRunningPayload }
export type FermentPausedEvent = FermentEventBase & { type: "ferment_paused"; payload: FermentPausedPayload }
export type FermentResumedEvent = FermentEventBase & { type: "ferment_resumed"; payload: FermentResumedPayload }
export type FermentCompletedEvent = FermentEventBase & { type: "ferment_completed"; payload: FermentCompletedPayload }
export type FermentRenamedEvent = FermentEventBase & { type: "ferment_renamed"; payload: FermentRenamedPayload }
export type FermentModeSetEvent = FermentEventBase & { type: "ferment_mode_set"; payload: FermentModeSetPayload }
export type PhaseActivatedEvent = FermentEventBase & { type: "phase_activated"; payload: PhaseActivatedPayload }
export type PhaseGroupActivatedEvent = FermentEventBase & {
	type: "phase_group_activated"
	payload: PhaseGroupActivatedPayload
}
export type PhaseCompletedEvent = FermentEventBase & { type: "phase_completed"; payload: PhaseCompletedPayload }
export type PhaseSkippedEvent = FermentEventBase & { type: "phase_skipped"; payload: PhaseSkippedPayload }
export type PhaseFailedEvent = FermentEventBase & { type: "phase_failed"; payload: PhaseFailedPayload }
export type PhaseRefinedEvent = FermentEventBase & { type: "phase_refined"; payload: PhaseRefinedPayload }
export type PhaseGradedEvent = FermentEventBase & { type: "phase_graded"; payload: PhaseGradedPayload }
export type StepStartedEvent = FermentEventBase & { type: "step_started"; payload: StepStartedPayload }
export type StepCompletedEvent = FermentEventBase & { type: "step_completed"; payload: StepCompletedPayload }
export type StepSkippedEvent = FermentEventBase & { type: "step_skipped"; payload: StepSkippedPayload }
export type StepFailedEvent = FermentEventBase & { type: "step_failed"; payload: StepFailedPayload }
export type StepVerifiedEvent = FermentEventBase & { type: "step_verified"; payload: StepVerifiedPayload }
export type StepGradedEvent = FermentEventBase & { type: "step_graded"; payload: StepGradedPayload }
export type StepDescriptionUpdatedEvent = FermentEventBase & {
	type: "step_description_updated"
	payload: StepDescriptionUpdatedPayload
}
export type FermentGradedEvent = FermentEventBase & { type: "ferment_graded"; payload: FermentGradedPayload }
export type DecisionAddedEvent = FermentEventBase & { type: "decision_added"; payload: DecisionAddedPayload }
export type MemoryAddedEvent = FermentEventBase & { type: "memory_added"; payload: MemoryAddedPayload }
export type WorktreeUpdatedEvent = FermentEventBase & { type: "worktree_updated"; payload: WorktreeUpdatedPayload }
export type FermentAbandonedEvent = FermentEventBase & { type: "ferment_abandoned"; payload: FermentAbandonedPayload }

export type FermentEvent =
	| FermentCreatedEvent
	| FermentScopedEvent
	| ScopingGoalSetEvent
	| ScopingCriteriaSetEvent
	| ScopingConstraintsSetEvent
	| ScopingPhasesSetEvent
	| ScopingAssumptionsSetEvent
	| FermentPlannedEvent
	| FermentRunningEvent
	| FermentPausedEvent
	| FermentResumedEvent
	| FermentCompletedEvent
	| FermentRenamedEvent
	| FermentModeSetEvent
	| PhaseActivatedEvent
	| PhaseGroupActivatedEvent
	| PhaseCompletedEvent
	| PhaseSkippedEvent
	| PhaseFailedEvent
	| PhaseRefinedEvent
	| PhaseGradedEvent
	| StepStartedEvent
	| StepCompletedEvent
	| StepSkippedEvent
	| StepFailedEvent
	| StepVerifiedEvent
	| StepGradedEvent
	| StepDescriptionUpdatedEvent
	| FermentGradedEvent
	| DecisionAddedEvent
	| MemoryAddedEvent
	| WorktreeUpdatedEvent
	| FermentAbandonedEvent

// ─── Event Store ──────────────────────────────────────────────────────────────

export class FermentEventStore {
	private readonly storage: FermentStorage

	constructor(private readonly dir?: string) {
		this.storage = new FermentStorage(dir)
	}

	// ─── Internal helpers ───────────────────────────────────────────────────────

	/** Event log path is always keyed by ferment ID. */
	private eventsPath(fermentId: string): string {
		const baseDir = this.dir ?? resolveFermentsDir()
		return resolve(baseDir, `${fermentId}.events.jsonl`)
	}

	private snapshotPath(id: string): string {
		const baseDir = this.dir ?? resolveFermentsDir()
		return resolve(baseDir, `${id}.json`)
	}

	private hasEvents(id: string): boolean {
		return existsSync(this.eventsPath(id))
	}

	private shouldUseEvents(id: string): boolean {
		if (!this.hasEvents(id)) return false
		const eventsMtime = statSync(this.eventsPath(id)).mtimeMs
		const snapPath = this.snapshotPath(id)
		if (!existsSync(snapPath)) return true // no snapshot — must use events
		const snapMtime = statSync(snapPath).mtimeMs
		return eventsMtime >= snapMtime
	}

	private appendEvent(fermentId: string, event: FermentEvent): void {
		const path = this.eventsPath(fermentId)
		mkdirSync(resolve(path, ".."), { recursive: true })
		writeFileSync(path, `${JSON.stringify(event)}\n`, { flag: "a", encoding: "utf-8" })
	}

	/**
	 * Run `fn` while holding an exclusive cross-process lock on the ferment's
	 * snapshot file. Used to make the dual-write (snapshot + event log) atomic
	 * from any reader's perspective and to serialize concurrent mutations from
	 * parallel subagents racing on the same ferment.
	 *
	 * `proper-lockfile.lockSync` requires the target file to exist; we touch it
	 * if it doesn't. The release is best-effort — if it throws (e.g. lock was
	 * already released by a stale-recovery path), we swallow the error rather
	 * than masking the underlying mutation result.
	 */
	private withLock<T>(fermentId: string, fn: () => T): T {
		const snapPath = this.snapshotPath(fermentId)
		mkdirSync(resolve(snapPath, ".."), { recursive: true })
		const existedBeforeLock = existsSync(snapPath)
		if (!existsSync(snapPath)) {
			closeSync(openSync(snapPath, "a"))
		}
		// `lockSync` does not accept `retries` (the async API does). For
		// contended locks we hand-roll a retry loop with exponential backoff,
		// because the sync API just throws ELOCKED on conflict.
		let release: () => void = () => {}
		const start = Date.now()
		const maxWaitMs = 5_000
		let attempt = 0
		while (true) {
			try {
				release = lockSync(snapPath, { stale: 30_000 })
				break
			} catch (err) {
				if (Date.now() - start >= maxWaitMs) throw err
				const wait = Math.min(50 * 2 ** attempt, 500)
				attempt++
				const end = Date.now() + wait
				while (Date.now() < end) {
					// busy-wait — sync lock retry
				}
			}
		}
		try {
			return fn()
		} finally {
			try {
				release()
			} catch {
				// Lock may have been released by stale-recovery; safe to ignore.
			}
			if (!existedBeforeLock && existsSync(snapPath) && statSync(snapPath).size === 0) {
				unlinkSync(snapPath)
			}
		}
	}

	/**
	 * Append one event to the log with pre/post hashes derived from the supplied
	 * states. Used by the convenience methods (`create`, `addDecision`, etc.) that
	 * already hold both pre and post in scope; callers using `applyAndPersist` go
	 * through `writeWithEvents` instead.
	 */
	private emit(pre: Ferment, post: Ferment, type: FermentEventType, payload: unknown, timestamp?: string): Ferment {
		const event = {
			id: uuidv7(),
			// Default to post.updatedAt so the event timestamp matches the snapshot's
			// recorded mutation time. Without this, the fold's reconstructed
			// updatedAt drifts from the snapshot's by however long elapsed between
			// storage.create()/etc. and the emit call — which breaks the hash chain
			// across command boundaries even though both sides are computing
			// "the right thing" in isolation.
			timestamp: timestamp ?? post.updatedAt,
			type,
			preStateHash: stateHash(pre),
			postStateHash: stateHash(post),
			payload,
		} as FermentEvent

		this.appendEvent(post.id, event)
		return post
	}

	// ─── Fold events to reconstruct state ──────────────────────────────────────

	private foldEvents(id: string): Ferment | undefined {
		const path = this.eventsPath(id)
		if (!existsSync(path)) return undefined
		const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean)
		let state: Ferment | undefined
		for (const line of lines) {
			const event = JSON.parse(line) as FermentEvent
			state = this.applyEvent(state, event)
		}
		return state
	}

	/** Apply a single event to a (possibly undefined) ferment state. Delegates to the
	 *  free `applyFermentEvent` so the mapper and migration share one source of truth
	 *  for "what does this event do". */
	private applyEvent(state: Ferment | undefined, event: FermentEvent): Ferment {
		return applyFermentEvent(state, event)
	}

	// ─── Public read API (backward-compatible with FermentStorage) ─────────────

	get(id: string): Ferment | undefined {
		if (this.shouldUseEvents(id)) {
			return this.foldEvents(id)
		}
		return this.storage.get(id)
	}

	list(): import("./store.js").FermentListItem[] {
		return this.storage.list()
	}

	resolve(value: string): Ferment | undefined {
		return this.storage.resolve(value)
	}

	isFullyTerminal(id: string): boolean {
		return this.storage.isFullyTerminal(id)
	}

	// ─── Unified mutation entry ────────────────────────────────────────────────

	/**
	 * Persist a post-state Ferment to the snapshot AND append the supplied events
	 * to the event log. This is the only mutation entry point for callers that
	 * derive state via the pure state machine.
	 *
	 * Callers (typically `applyAndPersist`) are responsible for producing the
	 * correct events via `commandToEvents`. The store does not itself derive
	 * events from the post-state — it only persists what was given.
	 */
	writeWithEvents(post: Ferment, events: FermentEvent[]): Ferment {
		return this.withLock(post.id, () => {
			this.storage.write(post)
			for (const event of events) {
				this.appendEvent(post.id, event)
			}
			return post
		})
	}

	/**
	 * Run a full read → derive → write mutation under one ferment lock.
	 *
	 * This is the safe path for state-machine commands: concurrent workers must
	 * derive their post-state from the latest on-disk state, not from a snapshot
	 * read before waiting on the lock.
	 */
	mutateWithEvents<T>(
		id: string,
		fn: (
			current: Ferment | undefined,
		) => { write: true; ferment: Ferment; events: FermentEvent[]; value: T } | { write: false; value: T },
	): T {
		return this.withLock(id, () => {
			const current = this.shouldUseEvents(id) ? this.foldEvents(id) : this.storage.get(id)
			const result = fn(current)
			if (result.write) {
				this.storage.write(result.ferment)
				for (const event of result.events) {
					this.appendEvent(result.ferment.id, event)
				}
			}
			return result.value
		})
	}

	// ─── Core CRUD (dual-write) ────────────────────────────────────────────────

	create(name: string, description?: string): Ferment {
		// storage.create allocates the UUID; we don't know it until after the call
		// runs. So the lock for the genesis event covers only the emit, not the
		// snapshot creation itself. That's safe because the snapshot path can't
		// collide before the UUID is assigned.
		const ferment = this.storage.create(name, description)
		return this.withLock(ferment.id, () => {
			// `pre` for ferment_created is conceptually empty — we use the post to anchor
			// the chain at a deterministic value (preStateHash := postStateHash for the
			// genesis event). Chain consumers know the genesis event has no real pre.
			// We pass createdAt + worktree in the payload so fold reproduces the
			// snapshot exactly; otherwise the fold leaves worktree empty and uses
			// event.timestamp instead of the storage's create-time, breaking hash chain
			// equivalence at the very first command boundary.
			this.emit(
				ferment,
				ferment,
				"ferment_created",
				{
					id: ferment.id,
					name: ferment.name,
					description: ferment.description,
					worktree: ferment.worktree,
					createdAt: ferment.createdAt,
				},
				ferment.createdAt,
			)
			return ferment
		})
	}

	delete(id: string): boolean {
		return this.withLock(id, () => {
			if (this.hasEvents(id)) {
				unlinkSync(this.eventsPath(id))
			}
			return this.storage.delete(id)
		})
	}

	// ─── Decisions & Memories (dual-write) ────────────────────────────────────
	// These don't go through the state machine — they're additive append helpers
	// invoked directly by tools without producing a Command.

	addDecision(id: string, title: string, description: string, phaseId?: string, stepId?: string): Ferment | undefined {
		return this.withLock(id, () => {
			const pre = this.storage.get(id)
			if (!pre) return undefined
			const result = this.storage.addDecision(id, title, description, phaseId, stepId)
			if (!result) return undefined
			const decision = result.decisions[result.decisions.length - 1]
			this.emit(pre, result, "decision_added", { decision })
			return result
		})
	}

	addMemory(
		id: string,
		category: MemoryCategory,
		content: string,
		phaseId?: string,
		stepId?: string,
	): Ferment | undefined {
		return this.withLock(id, () => {
			const pre = this.storage.get(id)
			if (!pre) return undefined
			const result = this.storage.addMemory(id, category, content, phaseId, stepId)
			if (!result) return undefined
			const memory = result.memories[result.memories.length - 1]
			this.emit(pre, result, "memory_added", { memory })
			return result
		})
	}

	/** Update worktree metadata (branch / dirty / commit / path). Emits worktree_updated. */
	updateWorktree(id: string, worktree: Ferment["worktree"]): Ferment | undefined {
		return this.withLock(id, () => {
			const current = this.storage.get(id)
			if (!current) return undefined
			const updated: Ferment = { ...current, worktree, updatedAt: new Date().toISOString() }
			this.storage.write(updated)
			this.emit(current, updated, "worktree_updated", { worktree })
			return updated
		})
	}

	// ─── Migration ─────────────────────────────────────────────────────────────

	/**
	 * Migrate a legacy (snapshot-only) ferment to the event log format.
	 *
	 * Reads the existing snapshot and synthesises events for every observable
	 * state change. Only needs to be called once per legacy ferment.
	 * After migration both the snapshot and the event log coexist; reads decide
	 * which to use based on mtime.
	 */
	migrateLegacy(id: string): Ferment | undefined {
		return this.withLock(id, () => this._migrateLegacyLocked(id))
	}

	private _migrateLegacyLocked(id: string): Ferment | undefined {
		const ferment = this.storage.get(id)
		if (!ferment) return undefined
		if (this.hasEvents(id)) return ferment // already migrated

		const now = ferment.updatedAt

		// Build a list of (timestamp, type, payload) tuples in temporal order, then
		// fold them through applyEvent to maintain a meaningful pre/postStateHash
		// chain. Each event's preStateHash matches the prior event's postStateHash.
		type Pending = { timestamp: string; type: FermentEventType; payload: unknown }
		const pending: Pending[] = []

		// Stage 0: ferment_created (chain starts at zero)
		pending.push({
			timestamp: ferment.createdAt,
			type: "ferment_created",
			payload: {
				id: ferment.id,
				name: ferment.name,
				description: ferment.description,
			},
		})

		// Stage 1: scoping events (per-field, then ferment_planned if status flipped)
		if (ferment.scoping.goal) {
			pending.push({ timestamp: ferment.createdAt, type: "scoping_goal_set", payload: { goal: ferment.scoping.goal } })
		}
		if (ferment.scoping.criteria) {
			pending.push({
				timestamp: ferment.createdAt,
				type: "scoping_criteria_set",
				payload: { criteria: ferment.scoping.criteria },
			})
		}
		if (ferment.scoping.constraints) {
			pending.push({
				timestamp: ferment.createdAt,
				type: "scoping_constraints_set",
				payload: { constraints: ferment.scoping.constraints },
			})
		}
		// Emit scoping_phases_set whenever the legacy snapshot has phases, even if
		// scoping.phases was never set — without this, the synthesized log loses
		// every phase on fold (the structural Phase[] lives separately from Scoping).
		if (ferment.phases.length > 0) {
			const synthesizedAnswer: import("./types.js").ScopingAnswer = ferment.scoping.phases ?? {
				answer: `${ferment.phases.length} phase(s)`,
				confirmedAt: ferment.createdAt,
			}
			pending.push({
				timestamp: ferment.createdAt,
				type: "scoping_phases_set",
				payload: { phases: synthesizedAnswer, phaseSnapshots: ferment.phases },
			})
		}
		// ferment_planned only if the ferment ever progressed beyond draft.
		if (ferment.status !== "draft") {
			pending.push({ timestamp: ferment.createdAt, type: "ferment_planned", payload: {} })
		}

		// Stage 2: per-phase + per-step events in temporal order
		for (const phase of ferment.phases) {
			if (phase.startedAt) {
				pending.push({
					timestamp: phase.startedAt,
					type: "phase_activated",
					payload: { phaseId: phase.id, startedAt: phase.startedAt, groupIndex: phase.groupIndex },
				})
			}
			if (phase.steps.length > 0) {
				pending.push({
					timestamp: phase.startedAt ?? ferment.createdAt,
					type: "phase_refined",
					payload: { phaseId: phase.id, steps: phase.steps },
				})
			}
			for (const step of phase.steps) {
				if (step.startedAt) {
					pending.push({
						timestamp: step.startedAt,
						type: "step_started",
						payload: {
							phaseId: phase.id,
							stepId: step.id,
							startedAt: step.startedAt,
						},
					})
				}
				if (step.status === "done") {
					pending.push({
						timestamp: step.completedAt ?? now,
						type: "step_completed",
						payload: { phaseId: phase.id, stepId: step.id, completedAt: step.completedAt ?? now },
					})
				} else if (step.status === "skipped") {
					pending.push({
						timestamp: step.completedAt ?? now,
						type: "step_skipped",
						payload: { phaseId: phase.id, stepId: step.id, completedAt: step.completedAt ?? now },
					})
				} else if (step.status === "failed") {
					pending.push({
						timestamp: step.completedAt ?? now,
						type: "step_failed",
						payload: {
							phaseId: phase.id,
							stepId: step.id,
							error: step.result?.stderr,
							completedAt: step.completedAt ?? now,
						},
					})
				} else if (step.status === "verified") {
					pending.push({
						timestamp: step.completedAt ?? now,
						type: "step_verified",
						payload: {
							phaseId: phase.id,
							stepId: step.id,
							result: step.result ?? { success: true, completedAt: step.completedAt ?? now },
							verifiedAt: step.completedAt ?? now,
							exitCode: step.result?.exitCode ?? (step.result?.success ? 0 : 1),
						},
					})
				}
				if (step.grade) {
					pending.push({
						timestamp: step.grade.gradedAt,
						type: "step_graded",
						payload: { phaseId: phase.id, stepId: step.id, grade: step.grade, gradedAt: step.grade.gradedAt },
					})
				}
			}
			if (phase.status === "completed") {
				pending.push({
					timestamp: phase.completedAt ?? now,
					type: "phase_completed",
					payload: { phaseId: phase.id, summary: phase.summary ?? "", completedAt: phase.completedAt ?? now },
				})
			} else if (phase.status === "skipped") {
				pending.push({
					timestamp: phase.completedAt ?? now,
					type: "phase_skipped",
					payload: { phaseId: phase.id, reason: phase.summary, completedAt: phase.completedAt ?? now },
				})
			} else if (phase.status === "failed") {
				pending.push({
					timestamp: phase.completedAt ?? now,
					type: "phase_failed",
					payload: { phaseId: phase.id, reason: phase.summary ?? "", completedAt: phase.completedAt ?? now },
				})
			}
			if (phase.grade) {
				pending.push({
					timestamp: phase.grade.gradedAt,
					type: "phase_graded",
					payload: { phaseId: phase.id, grade: phase.grade },
				})
			}
		}

		// Stage 4: decisions + memories
		for (const decision of ferment.decisions) {
			pending.push({ timestamp: decision.createdAt, type: "decision_added", payload: { decision } })
		}
		for (const memory of ferment.memories) {
			pending.push({ timestamp: memory.createdAt, type: "memory_added", payload: { memory } })
		}

		// Stage 5: terminal status
		if (ferment.grade) {
			pending.push({ timestamp: ferment.grade.gradedAt, type: "ferment_graded", payload: { grade: ferment.grade } })
		}
		if (ferment.status === "complete") {
			pending.push({
				timestamp: ferment.updatedAt,
				type: "ferment_completed",
				payload: { completedAt: ferment.updatedAt },
			})
		} else if (ferment.status === "abandoned") {
			const reasonMatch = ferment.description?.match(/Abandoned: (.+)$/m)
			pending.push({
				timestamp: ferment.updatedAt,
				type: "ferment_abandoned",
				payload: { reason: reasonMatch?.[1] },
			})
		} else if (ferment.status === "paused") {
			pending.push({ timestamp: ferment.updatedAt, type: "ferment_paused", payload: {} })
		}

		// Stable sort by timestamp; ties preserve insertion order (Array.prototype.sort
		// in V8 is stable since ES2019).
		pending.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

		// Fold through applyEvent to compute meaningful pre/post hashes.
		const events: FermentEvent[] = []
		let cursor: Ferment | undefined
		let chainHash = "0".repeat(16)
		for (const p of pending) {
			const event = {
				id: uuidv7(),
				timestamp: p.timestamp,
				type: p.type,
				preStateHash: chainHash,
				postStateHash: chainHash, // placeholder, overwritten below
				payload: p.payload,
			} as FermentEvent
			cursor = this.applyEvent(cursor, event)
			const post = stateHash(cursor)
			event.postStateHash = post
			chainHash = post
			events.push(event)
		}

		const path = this.eventsPath(id)
		mkdirSync(resolve(path, ".."), { recursive: true })
		const lines = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`
		writeFileSync(path, lines, "utf-8")

		return ferment
	}
}

// ─── Pure fold step ───────────────────────────────────────────────────────────

/** Drop deprecated model-policy keys from refined-step payloads. Historic
 *  events may carry `workerModel`/`needsVision`; the live `Step` type no
 *  longer declares them, so strip them at the fold to keep reconstructed
 *  state clean. */
function normalizeRefinedStep(s: Step, i: number): Step {
	const {
		workerModel: _wm,
		needsVision: _nv,
		...rest
	} = s as Step & {
		workerModel?: unknown
		needsVision?: unknown
	}
	return { ...rest, index: i + 1 }
}

function settleAfterResume(state: Ferment, timestamp: string): Ferment {
	const activePhase = state.phases.find((p) => p.status === "active")
	if (activePhase) {
		return { ...state, status: "running", activePhaseId: activePhase.id, updatedAt: timestamp }
	}
	const { activePhaseId: _activePhaseId, ...rest } = state
	return { ...rest, status: "planned", updatedAt: timestamp }
}

/**
 * Apply one event to a (possibly undefined) ferment state and return the new
 * state. Pure — no I/O.
 *
 * Exported so command-mapper code can compute meaningful intermediate state
 * hashes via the same logic the event store uses internally during fold.
 * There is exactly one source of truth for "what does this event do".
 */
export function applyFermentEvent(state: Ferment | undefined, event: FermentEvent): Ferment {
	switch (event.type) {
		case "ferment_created": {
			const p = event.payload as FermentCreatedPayload
			const ts = p.createdAt ?? event.timestamp
			return {
				id: p.id,
				name: p.name,
				description: p.description,
				status: "draft",
				worktree: p.worktree ?? { path: "" },
				scoping: {},
				phases: [],
				decisions: [],
				memories: [],
				createdAt: ts,
				updatedAt: ts,
			}
		}
		case "ferment_scoped": {
			// Legacy fold path — old logs that emitted a single ferment_scoped event.
			if (!state) throw new Error("ferment_scoped requires existing state")
			const p = event.payload as FermentScopedPayload
			return { ...state, scoping: p.scoping, updatedAt: event.timestamp }
		}
		case "scoping_goal_set": {
			if (!state) throw new Error("scoping_goal_set requires existing state")
			const p = event.payload as ScopingGoalSetPayload
			return {
				...state,
				goal: p.plain ?? p.goal.answer,
				scoping: { ...state.scoping, goal: p.goal },
				updatedAt: event.timestamp,
			}
		}
		case "scoping_criteria_set": {
			if (!state) throw new Error("scoping_criteria_set requires existing state")
			const p = event.payload as ScopingCriteriaSetPayload
			return {
				...state,
				successCriteria: p.plain ?? p.criteria.answer,
				scoping: { ...state.scoping, criteria: p.criteria },
				updatedAt: event.timestamp,
			}
		}
		case "scoping_constraints_set": {
			if (!state) throw new Error("scoping_constraints_set requires existing state")
			const p = event.payload as ScopingConstraintsSetPayload
			return {
				...state,
				constraints:
					p.plain ??
					p.constraints.answer
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean),
				scoping: { ...state.scoping, constraints: p.constraints },
				updatedAt: event.timestamp,
			}
		}
		case "scoping_phases_set": {
			if (!state) throw new Error("scoping_phases_set requires existing state")
			const p = event.payload as ScopingPhasesSetPayload
			return {
				...state,
				scoping: { ...state.scoping, phases: p.phases },
				phases: p.phaseSnapshots,
				updatedAt: event.timestamp,
			}
		}
		case "scoping_assumptions_set": {
			if (!state) throw new Error("scoping_assumptions_set requires existing state")
			const p = event.payload as ScopingAssumptionsSetPayload
			return {
				...state,
				scoping: { ...state.scoping, assumptions: p.assumptions },
				updatedAt: event.timestamp,
			}
		}
		case "ferment_planned":
			if (!state) throw new Error("ferment_planned requires existing state")
			return { ...state, status: "planned", updatedAt: event.timestamp }
		case "ferment_running":
			if (!state) throw new Error("ferment_running requires existing state")
			return { ...state, status: "running", updatedAt: event.timestamp }
		case "ferment_paused":
			if (!state) throw new Error("ferment_paused requires existing state")
			return {
				...state,
				status: "paused",
				phases: state.phases.map((p) => ({
					...p,
					steps: p.steps.map((s) => (s.status === "running" ? { ...s, status: "pending" as const } : s)),
				})),
				updatedAt: event.timestamp,
			}
		case "ferment_resumed":
			if (!state) throw new Error("ferment_resumed requires existing state")
			return settleAfterResume(state, event.timestamp)
		case "ferment_completed": {
			if (!state) throw new Error("ferment_completed requires existing state")
			const p = event.payload as FermentCompletedPayload
			return {
				...state,
				status: "complete",
				description: p.finalSummary
					? state.description
						? `${state.description}\n\n${p.finalSummary}`
						: p.finalSummary
					: state.description,
				updatedAt: event.timestamp,
			}
		}
		case "ferment_renamed": {
			if (!state) throw new Error("ferment_renamed requires existing state")
			const p = event.payload as FermentRenamedPayload
			return { ...state, name: p.name, updatedAt: event.timestamp }
		}
		case "ferment_mode_set": {
			if (!state) throw new Error("ferment_mode_set requires existing state")
			return { ...state, updatedAt: event.timestamp }
		}
		case "phase_activated": {
			if (!state) throw new Error("phase_activated requires existing state")
			const p = event.payload as PhaseActivatedPayload
			return {
				...state,
				phases: activateSinglePhase(state.phases, p.phaseId, event.timestamp),
				lastActiveAt: event.timestamp,
				activePhaseId: p.phaseId,
				updatedAt: event.timestamp,
			}
		}
		case "phase_group_activated": {
			if (!state) throw new Error("phase_group_activated requires existing state")
			const p = event.payload as PhaseGroupActivatedPayload
			const ids = new Set(p.phaseIds)
			return {
				...state,
				phases: state.phases.map((ph) => {
					if (ids.has(ph.id)) {
						return { ...ph, status: "active" as const, startedAt: p.startedAt }
					}
					if (ph.status === "active" && !ids.has(ph.id)) {
						return { ...ph, status: "planned" as const }
					}
					return ph
				}),
				activePhaseId: p.phaseIds[0],
				lastActiveAt: p.startedAt,
				updatedAt: event.timestamp,
			}
		}
		case "phase_completed": {
			if (!state) throw new Error("phase_completed requires existing state")
			const p = event.payload as PhaseCompletedPayload
			const phases = state.phases.map((ph) =>
				ph.id === p.phaseId
					? { ...ph, status: "completed" as const, summary: p.summary, completedAt: event.timestamp }
					: ph,
			)
			return settleAfterPhaseTerminal(state, phases, event.timestamp)
		}
		case "phase_skipped": {
			if (!state) throw new Error("phase_skipped requires existing state")
			const p = event.payload as PhaseSkippedPayload
			const phases = state.phases.map((ph) =>
				ph.id === p.phaseId
					? {
							...ph,
							status: "skipped" as const,
							summary: p.reason ?? "Skipped",
							completedAt: event.timestamp,
						}
					: ph,
			)
			return settleAfterPhaseTerminal(state, phases, event.timestamp)
		}
		case "phase_failed": {
			if (!state) throw new Error("phase_failed requires existing state")
			const p = event.payload as PhaseFailedPayload
			const phases = state.phases.map((ph) =>
				ph.id === p.phaseId
					? { ...ph, status: "failed" as const, summary: p.reason, completedAt: event.timestamp }
					: ph,
			)
			return settleAfterPhaseTerminal(state, phases, event.timestamp)
		}
		case "phase_refined": {
			if (!state) throw new Error("phase_refined requires existing state")
			const p = event.payload as PhaseRefinedPayload
			return {
				...state,
				phases: state.phases.map((ph) =>
					ph.id === p.phaseId ? { ...ph, steps: p.steps.map((s, i) => normalizeRefinedStep(s, i)) } : ph,
				),
				updatedAt: event.timestamp,
			}
		}
		case "phase_graded": {
			if (!state) throw new Error("phase_graded requires existing state")
			const p = event.payload as PhaseGradedPayload
			return {
				...state,
				phases: state.phases.map((ph) => (ph.id === p.phaseId ? { ...ph, grade: p.grade } : ph)),
				updatedAt: event.timestamp,
			}
		}
		case "step_started": {
			if (!state) throw new Error("step_started requires existing state")
			const p = event.payload as StepStartedPayload
			return {
				...state,
				phases: state.phases.map((ph) =>
					ph.id === p.phaseId
						? {
								...ph,
								steps: ph.steps.map((s) =>
									s.id === p.stepId ? { ...s, status: "running" as const, startedAt: event.timestamp } : s,
								),
							}
						: ph,
				),
				updatedAt: event.timestamp,
			}
		}
		case "step_completed": {
			if (!state) throw new Error("step_completed requires existing state")
			const p = event.payload as StepCompletedPayload
			return {
				...state,
				phases: state.phases.map((ph) =>
					ph.id === p.phaseId
						? {
								...ph,
								steps: ph.steps.map((s) =>
									s.id === p.stepId ? { ...s, status: "done" as const, completedAt: event.timestamp } : s,
								),
							}
						: ph,
				),
				updatedAt: event.timestamp,
			}
		}
		case "step_skipped": {
			if (!state) throw new Error("step_skipped requires existing state")
			const p = event.payload as StepSkippedPayload
			return {
				...state,
				phases: state.phases.map((ph) =>
					ph.id === p.phaseId
						? {
								...ph,
								steps: ph.steps.map((s) =>
									s.id === p.stepId ? { ...s, status: "skipped" as const, completedAt: event.timestamp } : s,
								),
							}
						: ph,
				),
				updatedAt: event.timestamp,
			}
		}
		case "step_failed": {
			if (!state) throw new Error("step_failed requires existing state")
			const p = event.payload as StepFailedPayload
			return {
				...state,
				phases: state.phases.map((ph) =>
					ph.id === p.phaseId
						? {
								...ph,
								steps: ph.steps.map((s) =>
									s.id === p.stepId
										? {
												...s,
												status: "failed" as const,
												completedAt: event.timestamp,
												result: p.error ? { success: false, stderr: p.error, completedAt: event.timestamp } : undefined,
											}
										: s,
								),
							}
						: ph,
				),
				updatedAt: event.timestamp,
			}
		}
		case "step_verified": {
			if (!state) throw new Error("step_verified requires existing state")
			const p = event.payload as StepVerifiedPayload
			return {
				...state,
				phases: state.phases.map((ph) =>
					ph.id === p.phaseId
						? {
								...ph,
								steps: ph.steps.map((s) =>
									s.id === p.stepId
										? {
												...s,
												status: p.result.success ? ("verified" as const) : ("done" as const),
												completedAt: p.result.completedAt,
												result: p.result,
											}
										: s,
								),
							}
						: ph,
				),
				updatedAt: event.timestamp,
			}
		}
		case "step_graded": {
			if (!state) throw new Error("step_graded requires existing state")
			const p = event.payload as StepGradedPayload
			return {
				...state,
				phases: state.phases.map((ph) =>
					ph.id === p.phaseId
						? { ...ph, steps: ph.steps.map((s) => (s.id === p.stepId ? { ...s, grade: p.grade } : s)) }
						: ph,
				),
				updatedAt: event.timestamp,
			}
		}
		case "step_description_updated": {
			if (!state) throw new Error("step_description_updated requires existing state")
			const p = event.payload as StepDescriptionUpdatedPayload
			return {
				...state,
				phases: state.phases.map((ph) =>
					ph.id === p.phaseId
						? { ...ph, steps: ph.steps.map((s) => (s.id === p.stepId ? { ...s, description: p.description } : s)) }
						: ph,
				),
				updatedAt: event.timestamp,
			}
		}
		case "ferment_graded": {
			if (!state) throw new Error("ferment_graded requires existing state")
			const p = event.payload as FermentGradedPayload
			return { ...state, grade: p.grade, updatedAt: event.timestamp }
		}
		case "decision_added": {
			if (!state) throw new Error("decision_added requires existing state")
			const p = event.payload as DecisionAddedPayload
			return { ...state, decisions: [...state.decisions, p.decision], updatedAt: event.timestamp }
		}
		case "memory_added": {
			if (!state) throw new Error("memory_added requires existing state")
			const p = event.payload as MemoryAddedPayload
			return { ...state, memories: [...state.memories, p.memory], updatedAt: event.timestamp }
		}
		case "worktree_updated": {
			if (!state) throw new Error("worktree_updated requires existing state")
			const p = event.payload as WorktreeUpdatedPayload
			return { ...state, worktree: p.worktree, updatedAt: event.timestamp }
		}
		case "ferment_abandoned": {
			if (!state) throw new Error("ferment_abandoned requires existing state")
			const p = event.payload as FermentAbandonedPayload
			return {
				...state,
				status: "abandoned",
				description: p.reason
					? `${state.description ? `${state.description}\n\nAbandoned: ${p.reason}` : `Abandoned: ${p.reason}`}`
					: state.description,
				updatedAt: event.timestamp,
			}
		}
	}
}
