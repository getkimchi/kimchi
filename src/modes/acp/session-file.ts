import { randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { FileEntry, SessionHeader } from "@earendil-works/pi-coding-agent"
import { CURRENT_SESSION_VERSION, parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent"

/** Mirrors pi's cwd-scoped session directory layout. */
export function encodeCwdDir(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

/** Resolve the timestamp-prefixed JSONL file for a session ID, if present. */
export function resolveSessionPathById(sessionDir: string, sessionId: string): string | null {
	let entries: string[]
	try {
		entries = readdirSync(sessionDir)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
		throw err
	}
	const suffix = `_${sessionId}.jsonl`
	const bare = `${sessionId}.jsonl`
	const match = entries.find((entry) => entry === bare || entry.endsWith(suffix))
	return match ? join(sessionDir, match) : null
}

const SESSION_HEADER_PEEK_BYTES = 8 * 1024

function parseSessionHeader(raw: string): Pick<SessionHeader, "id" | "cwd" | "parentSession"> | null {
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) continue
		let entry: unknown
		try {
			entry = JSON.parse(trimmed)
		} catch {
			continue
		}
		if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "session") continue
		const header = entry as { id?: unknown; cwd?: unknown; parentSession?: unknown }
		if (typeof header.id !== "string" || typeof header.cwd !== "string") return null
		return {
			id: header.id,
			cwd: header.cwd,
			parentSession: typeof header.parentSession === "string" ? header.parentSession : undefined,
		}
	}
	return null
}

function readSessionHeaderPeek(sessionPath: string): { raw: string; complete: boolean } {
	const fd = openSync(sessionPath, "r")
	try {
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_PEEK_BYTES)
		const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
		return {
			raw: buffer.toString("utf-8", 0, bytesRead),
			complete: bytesRead < SESSION_HEADER_PEEK_BYTES,
		}
	} finally {
		closeSync(fd)
	}
}

/** Read the source session's identity and workspace without loading its transcript. */
export function readSessionHeader(sessionPath: string): Pick<SessionHeader, "id" | "cwd" | "parentSession"> | null {
	const peek = readSessionHeaderPeek(sessionPath)
	const parseablePeek = peek.complete ? peek.raw : peek.raw.slice(0, Math.max(0, peek.raw.lastIndexOf("\n") + 1))
	const header = parseSessionHeader(parseablePeek)
	if (header || peek.complete) return header
	return parseSessionHeader(readFileSync(sessionPath, "utf-8"))
}

const ACP_FORK_ENTRY_TYPE = "kimchi:acp-fork"
const ACP_FORK_EXTERNAL_SUBAGENT_ENTRY = "kimchi:acp-fork-subagent-metadata"

/** Positive lineage proof accepted from an ACP-created fork. Malformed or
 * unrecognized provenance returns false. Filesystem read errors are deliberately
 * propagated: callers must preserve the read-only boundary for both outcomes. */
export function hasAcpForkProvenance(sessionPath: string): boolean {
	const provenance = parseSessionEntries(readSessionHeaderPeek(sessionPath).raw)[1]
	return provenance?.type === "custom" && provenance.customType === ACP_FORK_ENTRY_TYPE
}

export type AcpForkSource = {
	sessionId: string
	cwd: string
	sessionManager: SessionManager
}

type PersistAcpForkInput = {
	source?: AcpForkSource
	cwd: string
	sessionDir: string
	sourceId: string
	/** The exact source path validated by the caller, never rediscovered here. */
	sourcePath: string
}

function durableEntries(source: AcpForkSource, sourcePath: string): FileEntry[] {
	const liveEntries = source.sessionManager.getBranch()
	const fallbackHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: source.sessionId,
		timestamp: new Date().toISOString(),
		cwd: source.cwd,
	}
	try {
		const persisted = parseSessionEntries(readFileSync(sourcePath, "utf-8"))
		const persistedHeader = persisted.find((entry) => entry.type === "session") ?? fallbackHeader
		const durableById = new Map(persisted.filter((entry) => entry.type !== "session").map((entry) => [entry.id, entry]))
		return [persistedHeader, ...liveEntries.map((entry) => durableById.get(entry.id) ?? entry)]
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
	}
	return [fallbackHeader, ...liveEntries]
}

/**
 * Construct and serialize a complete, independently continuing ACP fork.
 * Parent lineage is retained, while child associations become inert metadata
 * with their original structural IDs and parent links intact.
 */
export function persistAcpFork({ source, cwd, sessionDir, sourceId, sourcePath }: PersistAcpForkInput): {
	sessionId: string
	path: string
} {
	const sourceEntries = source
		? durableEntries(source, sourcePath)
		: parseSessionEntries(readFileSync(sourcePath, "utf-8"))

	// In-memory managers migrate entries and regenerate the selected branch
	// without registering staging paths in Pi's process-wide live-session set
	// or rewriting the source file.
	const stagedSource = SessionManager.inMemory(cwd, undefined, sourceEntries)
	const liveLeafId = source?.sessionManager.getLeafId()
	if (liveLeafId) stagedSource.branch(liveLeafId)
	const leafId = stagedSource.getLeafId()
	if (leafId) stagedSource.createBranchedSession(leafId)
	else stagedSource.newSession({ parentSession: sourcePath })

	const sessionId = stagedSource.getSessionId()
	const timestamp = new Date().toISOString()
	const forkHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionId,
		timestamp,
		cwd,
		parentSession: sourcePath,
	}
	mkdirSync(sessionDir, { recursive: true })
	const path = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`)
	const provenance = {
		type: "custom",
		customType: ACP_FORK_ENTRY_TYPE,
		data: { sourceSessionId: sourceId },
		id: randomUUID(),
		parentId: null,
		timestamp,
	}
	const independentEntries = stagedSource
		.getEntries()
		.map((entry) =>
			entry.type === "custom" && entry.customType === "subagents:record"
				? { ...entry, customType: ACP_FORK_EXTERNAL_SUBAGENT_ENTRY, data: {} }
				: entry,
		)
	const contents = `${[forkHeader, provenance, ...independentEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n`
	const fd = openSync(path, "wx")
	try {
		try {
			writeFileSync(fd, contents, "utf8")
		} finally {
			closeSync(fd)
		}
	} catch (error) {
		rmSync(path, { force: true })
		throw error
	}
	return { sessionId, path }
}
