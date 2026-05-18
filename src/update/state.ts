import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { statePath } from "./paths.js"

export interface RepoState {
	checked_at: string
	latest_version: string
	release_url?: string
}

interface PersistedState {
	repos?: Record<string, unknown>
}

const TTL_MS = 60 * 60 * 1_000 // 1 Hour

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
 * so a corrupt state file can't block an actual update. No mutex — the
 * kimchi process is single-threaded and there's no second consumer of
 * this file.
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
