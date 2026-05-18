/**
 * Runtime-state persistence — disk-backed sidecar for the in-memory counters
 * and git refs that drive the gate-retry/escalation pipeline.
 *
 * What's persisted (per ferment, at `.kimchi/ferments/{fermentId}/runtime.json`):
 *   - stepStartCounts        (phaseId:stepId → int)  stuck-loop detector
 *   - blockRetries           (phaseId → int)         retry budget per phase
 *   - lastBlockHashes        (phaseId → string)      same-failure-twice detector
 *   - stepCompleteAttempts   (phaseId:stepId → int)  symmetric with stepStartCounts
 *   - phaseStartRefs         (phaseId → git sha)     captured at activate_ferment_phase, consumed at complete_ferment_phase for diff evidence
 *   - stepStartRefs          (phaseId:stepId → sha)  captured at start_ferment_step, consumed at complete_ferment_step for diff evidence
 *
 * What's NOT persisted (single-CLI-session only):
 *   - scopingInteractive / scopingConfirmed (TUI flow; local-only)
 *   - judge model handles, active ferment reference (process-scoped)
 *
 * The persistence pattern is write-through with an in-memory cache: every
 * mutation in state.ts goes through the existing Maps, then this module
 * serializes the whole ferment's snapshot to disk atomically (temp + rename).
 * On first access to any persisted store by fermentId, `hydrateFromDisk` reads
 * the JSON and merges it back into the in-memory Maps. Failed disk writes are
 * logged via the optional onError callback and never throw — the hot path
 * continues with the in-memory state.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { resolveFermentsDir } from "../../ferment/store.js"

export const RUNTIME_STATE_SCHEMA_VERSION = 1

export interface PersistedRuntimeState {
	schemaVersion: typeof RUNTIME_STATE_SCHEMA_VERSION
	/** Key: `${phaseId}:${stepId}`. Note: fermentId is implicit (per-file). */
	stepStartCounts: Record<string, number>
	/** Key: `${phaseId}`. */
	blockRetries: Record<string, number>
	/** Key: `${phaseId}`. FNV-1a hex of the prior block-flag set. */
	lastBlockHashes: Record<string, string>
	/** Key: `${phaseId}:${stepId}`. */
	stepCompleteAttempts: Record<string, number>
	/** Key: `${phaseId}`. Git sha captured at activate_ferment_phase. */
	phaseStartRefs: Record<string, string>
	/** Key: `${phaseId}:${stepId}`. Git sha captured at start_ferment_step. */
	stepStartRefs: Record<string, string>
}

export function emptyState(): PersistedRuntimeState {
	return {
		schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
		stepStartCounts: {},
		blockRetries: {},
		lastBlockHashes: {},
		stepCompleteAttempts: {},
		phaseStartRefs: {},
		stepStartRefs: {},
	}
}

function fermentSidecarDir(fermentId: string, root?: string): string {
	const base = root ?? resolveFermentsDir()
	return resolve(base, fermentId)
}

function runtimeStatePath(fermentId: string, root?: string): string {
	return resolve(fermentSidecarDir(fermentId, root), "runtime.json")
}

/** Read the persisted runtime state for a ferment, or `emptyState()` if there
 *  is none (file missing, parse error, schema mismatch). Failures are
 *  intentionally silent here — corruption shouldn't crash the hot path. */
export function loadRuntimeState(fermentId: string, root?: string): PersistedRuntimeState {
	const path = runtimeStatePath(fermentId, root)
	if (!existsSync(path)) return emptyState()
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<PersistedRuntimeState>
		if (raw.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION) return emptyState()
		// Defensive: every field must be an object (record). If anything is
		// missing or malformed, fall back to the empty default for that field
		// rather than the whole snapshot.
		const merged = emptyState()
		if (raw.stepStartCounts && typeof raw.stepStartCounts === "object") merged.stepStartCounts = raw.stepStartCounts
		if (raw.blockRetries && typeof raw.blockRetries === "object") merged.blockRetries = raw.blockRetries
		if (raw.lastBlockHashes && typeof raw.lastBlockHashes === "object") merged.lastBlockHashes = raw.lastBlockHashes
		if (raw.stepCompleteAttempts && typeof raw.stepCompleteAttempts === "object")
			merged.stepCompleteAttempts = raw.stepCompleteAttempts
		if (raw.phaseStartRefs && typeof raw.phaseStartRefs === "object") merged.phaseStartRefs = raw.phaseStartRefs
		if (raw.stepStartRefs && typeof raw.stepStartRefs === "object") merged.stepStartRefs = raw.stepStartRefs
		return merged
	} catch {
		return emptyState()
	}
}

/** Atomically write the runtime state for a ferment. Writes to a temp file
 *  then renames over the target so a crash during write cannot leave a
 *  truncated file. Best-effort: failures call `onError` if provided and
 *  return false; never throw. */
export function saveRuntimeState(
	fermentId: string,
	state: PersistedRuntimeState,
	options?: { root?: string; onError?: (err: unknown) => void },
): boolean {
	try {
		const dir = fermentSidecarDir(fermentId, options?.root)
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
		const path = runtimeStatePath(fermentId, options?.root)
		const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
		writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8")
		renameSync(tmp, path)
		return true
	} catch (err) {
		options?.onError?.(err)
		return false
	}
}

/** Delete the persisted runtime state for a ferment. Called when the ferment
 *  terminates (complete / abandon / delete). Best-effort — missing file is a
 *  no-op. */
export function deleteRuntimeState(fermentId: string, root?: string): void {
	try {
		const path = runtimeStatePath(fermentId, root)
		if (existsSync(path)) {
			// We don't unlink the directory — review-evidence sidecars may still live there.
			// Just truncate the runtime snapshot.
			writeFileSync(path, JSON.stringify(emptyState(), null, 2), "utf-8")
		}
	} catch {
		// Silent — cleanup failures shouldn't propagate.
	}
}
