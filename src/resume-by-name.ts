import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent"

/** Full-UUID shape, mirroring the selector gate in cli-args.ts. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isPathLike(value: string): boolean {
	return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/")
}

/** Selector-shaped values are already handled by normalizeResumeIdArgs. */
function looksLikeSelector(value: string): boolean {
	return UUID_RE.test(value) || isPathLike(value)
}

interface NameCandidate {
	/** Index of the flag token in args. */
	index: number
	/** Session name to resolve. */
	name: string
	/** True for the two-token `-r <name>` form (flag + value tokens). */
	consumesNext: boolean
}

function findNameCandidates(args: string[]): NameCandidate[] {
	const candidates: NameCandidate[] = []
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]
		if (arg === "-r" || arg === "--resume") {
			const next = args[i + 1]
			if (next !== undefined && !next.startsWith("-") && !looksLikeSelector(next)) {
				candidates.push({ index: i, name: next, consumesNext: true })
			}
		} else if (arg.startsWith("--resume=") && arg.length > "--resume=".length) {
			const value = arg.slice("--resume=".length)
			if (!looksLikeSelector(value)) candidates.push({ index: i, name: value, consumesNext: false })
		} else if (arg.startsWith("-r") && arg.length > 2) {
			const value = arg.slice(2)
			if (!looksLikeSelector(value)) candidates.push({ index: i, name: value, consumesNext: false })
		}
	}
	return candidates
}

/**
 * Pick the session a name refers to. Matching is exact but case-insensitive
 * (names are informal, user-typed labels). When several sessions share the
 * name, prefer the current project, then the most recently modified.
 */
export function pickSessionByName(
	sessions: readonly SessionInfo[],
	name: string,
	cwd: string,
): SessionInfo | undefined {
	const target = name.trim().toLowerCase()
	const matches = sessions.filter((session) => (session.name ?? "").trim().toLowerCase() === target)
	if (matches.length === 0) return undefined
	const local = matches.filter((session) => session.cwd === cwd)
	const pool = local.length > 0 ? local : matches
	return pool.reduce((best, session) => (session.modified > best.modified ? session : best))
}

/**
 * List every stored session under the kimchi sessions root.
 *
 * Sessions live in `<agentDir>/sessions/<encoded-cwd>/*.jsonl` (see
 * modes/acp/server.ts for the same layout). `SessionManager.listAll(dir)`
 * only reads JSONL files directly inside the given dir, so the per-project
 * subdirectories are enumerated here and scanned individually — mirroring
 * upstream's env-based listAll() default without relying on
 * PI_CODING_AGENT_DIR being set.
 */
async function listAllSessions(agentDir: string): Promise<SessionInfo[]> {
	const sessionsRoot = join(agentDir, "sessions")
	let entries: Dirent[]
	try {
		entries = await readdir(sessionsRoot, { withFileTypes: true })
	} catch {
		return []
	}
	const dirs = entries
		.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
		.map((entry) => join(sessionsRoot, entry.name))
	const perDir = await Promise.all(dirs.map((dir) => SessionManager.listAll(dir)))
	return perDir.flat()
}

/**
 * Rewrite `-r <name>` / `--resume <name>` / `--resume=<name>` / `-r<name>`
 * into `--session <path>` when a session with that name exists under
 * `<agentDir>/sessions`. Returns the args unchanged when there is nothing to
 * resolve or no session matches — fail-open to existing CLI behavior.
 */
export async function resolveResumeNameArgs(args: string[], agentDir: string, cwd: string): Promise<string[]> {
	const candidates = findNameCandidates(args)
	if (candidates.length === 0) return args

	const sessions = await listAllSessions(agentDir)
	if (sessions.length === 0) return args

	// Rewrite in reverse index order: the glued forms (`--resume=<name>`,
	// `-r<name>`) grow the array by one token, which would shift the indices
	// of later candidates.
	const result = [...args]
	let rewritten = false
	for (const candidate of candidates.reverse()) {
		const match = pickSessionByName(sessions, candidate.name, cwd)
		if (!match) continue
		rewritten = true
		result[candidate.index] = "--session"
		if (candidate.consumesNext) {
			result[candidate.index + 1] = match.path
		} else {
			result.splice(candidate.index + 1, 0, match.path)
		}
	}
	return rewritten ? result : args
}
