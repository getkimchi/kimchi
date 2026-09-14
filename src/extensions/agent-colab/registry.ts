/**
 * Peer registry — on-disk records of live agent-colab sessions.
 *
 * Each running TUI session that enables agent-colab writes one JSON record
 * under the state dir so other local sessions can discover it:
 *
 *   <sessionId>.json — { sessionId, pid, port, token, name?, cwd, startedAt }
 *
 * Records are pruned on read when the pid is gone (reboot pid reuse), and
 * malformed files are skipped rather than thrown (daemon/state.ts pattern).
 * The dir is ~/.config/kimchi/peers by default; AGENT_COLAB_STATE_DIR or the
 * `dir` parameter overrides it (tests use temp dirs).
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, sep } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"

export interface PeerRecord {
	/** pi/kimchi session id (uuid). Also the record filename stem. */
	sessionId: string
	/** Owning process — liveness check target. */
	pid: number
	/** Loopback port of this session's A2A inbox server. */
	port: number
	/** Bearer token required by that inbox server. */
	token: string
	/** Session display name (sessionManager.getSessionName()), if set. */
	name?: string
	cwd: string
	startedAt: string
}

/**
 * Root of the peer state directory. Resolution order:
 *   1. explicit override (tests)  2. AGENT_COLAB_STATE_DIR env
 *   3. agentDir hint — derived from the live session file path, which tracks
 *      the HOST's agent dir even when this package resolved its own copy of
 *      pi (vanilla pi: `~/.pi/agent`, kimchi: `~/.config/kimchi/harness`)
 *   4. pi's getAgentDir()  5. vanilla-pi fallback path
 */
export function peerStateDir(override?: string, agentDirHint?: string): string {
	if (override) return override
	const env = process.env.AGENT_COLAB_STATE_DIR
	if (env) return env
	if (agentDirHint) return join(agentDirHint, "peers")
	try {
		const agentDir = getAgentDir()
		if (agentDir) return join(agentDir, "peers")
	} catch {
		// Fall through to the vanilla-pi default.
	}
	return join(homedir(), ".pi", "agent", "peers")
}

/**
 * Infer the host harness's agent dir from a session file path:
 * `<agentDir>/sessions/<encodedCwd>/<file>.jsonl` → `<agentDir>`.
 * Returns undefined when the path doesn't match that shape.
 */
export function agentDirFromSessionFile(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined
	const parts = sessionFile.split(sep)
	const sessionsIndex = parts.lastIndexOf("sessions")
	// Need <agentDir>/sessions/<encodedCwd>/<file> — sessions not last/second-to-last.
	if (sessionsIndex < 1 || sessionsIndex > parts.length - 3) return undefined
	return parts.slice(0, sessionsIndex).join(sep)
}

/** True when the pid exists (kill(pid, 0) is existence-check only). */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err: unknown) {
		// EPERM means the process exists but is owned by someone else — alive.
		if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "EPERM") {
			return true
		}
		return false
	}
}

/** Validate a record read from disk; undefined when missing or malformed. */
export function parsePeerRecord(raw: unknown, expectedId: string): PeerRecord | undefined {
	if (typeof raw !== "object" || raw === null) return undefined
	const r = raw as Record<string, unknown>
	if (
		typeof r.sessionId !== "string" ||
		typeof r.pid !== "number" ||
		typeof r.port !== "number" ||
		typeof r.token !== "string" ||
		typeof r.cwd !== "string" ||
		typeof r.startedAt !== "string"
	) {
		return undefined
	}
	if (r.sessionId !== expectedId) return undefined
	if (!Number.isInteger(r.pid) || r.pid <= 0) return undefined
	if (!Number.isInteger(r.port) || r.port <= 0 || r.port > 65535) return undefined
	if (r.name !== undefined && typeof r.name !== "string") return undefined
	return {
		sessionId: r.sessionId,
		pid: r.pid,
		port: r.port,
		token: r.token,
		name: r.name,
		cwd: r.cwd,
		startedAt: r.startedAt,
	}
}

function recordPath(dir: string, sessionId: string): string {
	return join(dir, `${sessionId}.json`)
}

/** True when `filePath` resolves inside `dir` (guards hand-edited records). */
function isSafeStatePath(dir: string, filePath: string): boolean {
	if (!filePath.startsWith(sep)) return false
	return resolve(filePath).startsWith(resolve(dir) + sep)
}

export function registerPeer(dir: string, record: PeerRecord): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(recordPath(dir, record.sessionId), JSON.stringify(record, null, 2))
	try {
		chmodSync(recordPath(dir, record.sessionId), 0o600)
	} catch {
		// Best-effort (some filesystems ignore chmod); the token check on the
		// receiving server is the real gate.
	}
}

export function readPeer(dir: string, sessionId: string): PeerRecord | undefined {
	const path = recordPath(dir, sessionId)
	if (!existsSync(path)) return undefined
	let raw: unknown
	try {
		raw = JSON.parse(readFileSync(path, "utf8"))
	} catch {
		return undefined
	}
	const record = parsePeerRecord(raw, sessionId)
	if (!record) return undefined
	// A tampered record must not point outside the state dir we manage.
	if (!isSafeStatePath(dir, path)) return undefined
	return record
}

export function removePeer(dir: string, sessionId: string): void {
	rmSync(recordPath(dir, sessionId), { force: true })
}

// ---------------------------------------------------------------------------
// Persistent session names (survive restarts; keyed by sessionId).
// Stored as names.json — listLivePeers skips it because parsePeerRecord
// rejects its shape (no pid/port fields).

function namesPath(dir: string): string {
	return join(dir, "names.json")
}

export function readPeerName(dir: string, sessionId: string): string | undefined {
	const path = namesPath(dir)
	if (!existsSync(path)) return undefined
	try {
		const map = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
		const value = map[sessionId]
		return typeof value === "string" && value.trim() ? value.trim() : undefined
	} catch {
		return undefined
	}
}

export function writePeerName(dir: string, sessionId: string, name: string): void {
	mkdirSync(dir, { recursive: true })
	const path = namesPath(dir)
	let map: Record<string, string> = {}
	if (existsSync(path)) {
		try {
			map = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>
		} catch {
			map = {}
		}
	}
	map[sessionId] = name
	writeFileSync(path, JSON.stringify(map, null, 2))
}

export interface PeerListEntry {
	record: PeerRecord
	alive: boolean
}

/**
 * List recorded peers with liveness. Dead entries are pruned from the state
 * dir so a reboot's pid reuse doesn't leave phantom peers behind.
 */
export function listLivePeers(dir: string): PeerListEntry[] {
	if (!existsSync(dir)) return []
	const out: PeerListEntry[] = []
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue
		const sessionId = file.slice(0, -".json".length)
		const path = recordPath(dir, sessionId)
		let raw: unknown
		try {
			raw = JSON.parse(readFileSync(path, "utf8"))
		} catch {
			continue
		}
		const record = parsePeerRecord(raw, sessionId)
		if (!record) continue
		const alive = isPidAlive(record.pid)
		if (!alive) {
			removePeer(dir, sessionId)
			continue
		}
		out.push({ record, alive })
	}
	return out
}

/** Display label used in pickers and tool output: name or short id + cwd. */
export function peerLabel(record: PeerRecord): string {
	const id8 = record.sessionId.slice(0, 8)
	const title = record.name?.trim()
	return title ? `${title} (${id8}) · ${record.cwd}` : `session-${id8} · ${record.cwd}`
}

/**
 * Resolve a user/model-supplied peer reference (session name or id prefix)
 * against live peers. Returns the record, or an error string listing
 * candidates when ambiguous / not found.
 */
export function resolvePeer(query: string, peers: PeerRecord[]): { record: PeerRecord } | { error: string } {
	const q = query.trim()
	if (!q) return { error: "Peer reference is empty." }
	// Exact session name wins outright (name-addressing beats prefixes).
	const exact = peers.find((p) => p.name === q)
	if (exact) return { record: exact }
	const byName = peers.filter((p) => p.name?.startsWith(q))
	const byId = peers.filter((p) => p.sessionId.startsWith(q))
	const matches = [...new Map([...byName, ...byId].map((p) => [p.sessionId, p])).values()]
	if (matches.length === 0) {
		return { error: `No live session matches "${query}". Use list_peers to see candidates.` }
	}
	if (matches.length > 1) {
		return {
			error: `"${query}" is ambiguous — ${matches.length} sessions match: ${matches
				.map(peerLabel)
				.join("; ")}. Use a longer prefix or the full id.`,
		}
	}
	return { record: matches[0] }
}
