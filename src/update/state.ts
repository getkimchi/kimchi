import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { lastInstalledPath, statePath, updateResultPath } from "./paths.js"

export interface RepoState {
	checked_at: string
	latest_version: string
	release_url?: string
}

/** Tick outcomes of the background updater (docs/auto-update.md: update tick).
 *  Owned here so the persisted record and the tick share one vocabulary. */
export const UPDATE_OUTCOMES = ["skipped-lock", "no-update", "installed", "check-failed", "install-failed"] as const

export type UpdateOutcome = (typeof UPDATE_OUTCOMES)[number]

/** Record of the most recently installed release. The dedup primitive:
 *  a running session keeps its own version after installing (the install
 *  only applies to the NEXT launch), so without this record every other
 *  session would reinstall the same release on each of its ticks. */
export interface LastInstalledRecord {
	tag: string
	at: string
}

/** The update result (docs/auto-update.md): outcome of the most recent background
 *  tick, kept for diagnosis because failures are never shown to the user. */
export interface UpdateResultRecord {
	at: string
	outcome: UpdateOutcome
	version?: string
	error?: string
}

interface PersistedState {
	repos?: Record<string, unknown>
}

// Shared across sessions: the background update tick fires every 30
// minutes, so a 30-minute TTL means at most one GitHub check per machine
// per tick interval regardless of how many sessions are open.
const TTL_MS = 30 * 60 * 1_000 // 30 minutes

export function isStale(rs: RepoState, now: number = Date.now()): boolean {
	const t = Date.parse(rs.checked_at)
	if (Number.isNaN(t)) return true
	return now - t > TTL_MS
}

function repoKey(owner: string, name: string): string {
	return `${owner}/${name}`
}

function parseRepoState(raw: unknown): RepoState | null {
	if (!raw || typeof raw !== "object") return null
	const v = raw as Partial<RepoState>
	if (typeof v.checked_at !== "string") return null
	if (Number.isNaN(Date.parse(v.checked_at))) return null
	if (typeof v.latest_version !== "string" || v.latest_version === "") return null
	const out: RepoState = {
		checked_at: v.checked_at,
		latest_version: v.latest_version,
	}
	if (typeof v.release_url === "string") out.release_url = v.release_url
	return out
}

function loadState(): PersistedState | null {
	try {
		const raw = readFileSync(statePath(), "utf-8")
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== "object") return null
		return parsed as PersistedState
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
		// Treat corruption as missing — the next save will overwrite.
		return null
	}
}

function saveState(state: PersistedState): void {
	const path = statePath()
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const tmp = `${path}.tmp`
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
	renameSync(tmp, path)
}

/**
 * Read cached state for a repo. Returns null when missing, unparseable,
 * or in an unexpected shape (defensive: no schema mismatch should ever
 * crash the caller — they fall through to a refetch instead).
 */
export function loadRepoState(owner: string, name: string): RepoState | null {
	const state = loadState()
	if (!state?.repos) return null
	return parseRepoState(state.repos[repoKey(owner, name)])
}

/**
 * Read-modify-write the per-repo state. Best-effort: errors are swallowed
 * so a corrupt state file can't block an actual update. No mutex — several
 * concurrent sessions can interleave load/save; for the cache entry a lost
 * race costs only a refetch. Diagnostics (update result, last-installed)
 * keep their own files below so a stale cache load can never clobber them.
 */
export function saveRepoState(owner: string, name: string, rs: RepoState): void {
	try {
		const state = loadState() ?? {}
		const repos = (state.repos ?? {}) as Record<string, unknown>
		repos[repoKey(owner, name)] = rs
		saveState({ ...state, repos })
	} catch {
		// Cache is best-effort.
	}
}

/** Honors $KIMCHI_NO_UPDATE_CHECK=<anything-truthy>. */
export function isUpdateCheckDisabled(): boolean {
	const v = process.env.KIMCHI_NO_UPDATE_CHECK
	return v !== undefined && v !== ""
}

// Diagnostics live in their own single-record files (update-result.json,
// last-installed.json): one writer, one concern per file, so a concurrent
// repo-cache save can never clobber them the way shared load-modify-write
// fields could.

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as unknown
	} catch {
		return undefined
	}
}

function writeJsonFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const tmp = `${path}.tmp`
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
	renameSync(tmp, path)
}

function parseUpdateResult(raw: unknown): UpdateResultRecord | null {
	if (!raw || typeof raw !== "object") return null
	const v = raw as Partial<UpdateResultRecord>
	if (typeof v.outcome !== "string" || !(UPDATE_OUTCOMES as readonly string[]).includes(v.outcome)) return null
	if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null
	const out: UpdateResultRecord = { at: v.at, outcome: v.outcome as UpdateOutcome }
	if (typeof v.version === "string") out.version = v.version
	if (typeof v.error === "string") out.error = v.error
	return out
}

/** Record the outcome of one background tick. `at` is stamped here so
 *  callers can't forget the timestamp. Best-effort: never throws. */
export function saveUpdateResult(rec: Omit<UpdateResultRecord, "at">): void {
	try {
		writeJsonFile(updateResultPath(), { ...rec, at: new Date().toISOString() } satisfies UpdateResultRecord)
	} catch {
		// Best-effort diagnostics; must never affect the calling tick.
	}
}

/** The recorded outcome of the most recent background tick, or null when
 *  none was recorded or the file is unparseable. */
export function loadUpdateResult(): UpdateResultRecord | null {
	return parseUpdateResult(readJsonFile(updateResultPath()))
}

/** Record a successfully installed release (its tag, e.g. "v0.0.23").
 *  Best-effort: never throws. */
export function saveLastInstalled(tag: string): void {
	try {
		writeJsonFile(lastInstalledPath(), { tag, at: new Date().toISOString() } satisfies LastInstalledRecord)
	} catch {
		// Best-effort.
	}
}

/** The tag of the most recently installed release, or null. Drives the
 *  tick's reinstall dedup: a session still running the old version should
 *  not install a release another session already installed. */
export function loadLastInstalled(): LastInstalledRecord | null {
	const raw = readJsonFile(lastInstalledPath())
	if (!raw || typeof raw !== "object") return null
	const v = raw as Partial<LastInstalledRecord>
	if (typeof v.tag !== "string" || v.tag === "") return null
	if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null
	return { tag: v.tag, at: v.at }
}
