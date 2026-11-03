/**
 * Side chat transcripts: each side chat's own messages live in their own
 * JSONL file next to the main session, so the main session only carries a
 * lightweight record per side chat (see records.ts).
 *
 *   <session dir>/side-chats/<main session id>/<side chat id>.jsonl
 *
 * The file is in Pi's session format (header, then a linear chain of message
 * entries) so it can be inspected with the usual tools. It holds only the
 * side thread: the inherited main-session context is rebuilt from the main
 * session's branch point when the side chat is reopened, never copied.
 *
 * The path is derived from validated ids, never read from a record, so a
 * tampered record cannot point the store at an arbitrary file. Pi's
 * file-backed SessionManager is deliberately not used here: opening one
 * re-registers the "live" session file (`globalThis.__kimchiSessionFile`)
 * the main session relies on.
 *
 * A main session that is not persisted (`--no-session`) keeps side threads
 * in memory for the process lifetime.
 */

import { randomUUID } from "node:crypto"
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import {
	type AgentSession,
	CURRENT_SESSION_VERSION,
	type ExtensionContext,
	type FileEntry,
	parseSessionEntries,
	type SessionHeader,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent"

export const SIDE_CHAT_DIR = "side-chats"

/** Same shape Pi accepts for session ids; also keeps ids safe as path segments. */
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

export function isSafeId(id: unknown): id is string {
	return typeof id === "string" && SAFE_ID.test(id)
}

/** Side-thread messages, as stored and replayed. */
export type SideThread = AgentSession["messages"]

/**
 * Thread messages ready to persist: a trailing assistant reply that is still
 * streaming (`stopReason: "pending"`) is excluded — it is saved once the turn
 * settles. Closing a side chat aborts the turn first, so the saved reply
 * carries `stopReason: "aborted"` and a reopened chat shows it as interrupted
 * instead of as a plausible-looking final answer.
 */
export function persistableThread(thread: SideThread): SideThread {
	const last = thread[thread.length - 1]
	if (last?.role === "assistant" && last.stopReason === "pending") return thread.slice(0, -1)
	return thread
}

type MainSession = Pick<
	ExtensionContext["sessionManager"],
	"getCwd" | "getSessionDir" | "getSessionFile" | "getSessionId"
>

export interface SideChatLog {
	/** Side-thread messages persisted so far ([] when the transcript is missing). */
	read(): SideThread
	/** Append messages after those already persisted. */
	append(messages: SideThread): void
}

/** Transcript path of side chat `id` owned by main session `sessionId`; undefined for unsafe ids. */
export function sideChatFile(sessionDir: string, sessionId: string, id: string): string | undefined {
	if (!isSafeId(sessionId) || !isSafeId(id)) return undefined
	return join(sessionDir, SIDE_CHAT_DIR, sessionId, `${id}.jsonl`)
}

/** Side threads of non-persisted main sessions, keyed by `<session id>/<side chat id>`. */
const inMemoryThreads = new Map<string, SideThread>()

/** Log of side chat `id` owned by main session `sessionId` (defaults to the current main session). */
export function openSideChatLog(main: MainSession, id: string, sessionId = main.getSessionId()): SideChatLog {
	if (!main.getSessionFile()) return memoryLog(`${sessionId}/${id}`)
	const file = sideChatFile(main.getSessionDir(), sessionId, id)
	if (!file) return memoryLog(`${sessionId}/${id}`)
	return fileLog(file, { id, cwd: main.getCwd(), parentSession: main.getSessionFile() })
}

function memoryLog(key: string): SideChatLog {
	return {
		read: () => [...(inMemoryThreads.get(key) ?? [])],
		append: (messages) => {
			if (messages.length > 0) inMemoryThreads.set(key, [...(inMemoryThreads.get(key) ?? []), ...messages])
		},
	}
}

function fileLog(file: string, header: { id: string; cwd: string; parentSession?: string }): SideChatLog {
	/** Id of the last entry written, chaining `parentId`; resolved lazily from the file. */
	let lastId: string | null | undefined
	return {
		read: () => readEntries(file).flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
		append: (messages) => {
			if (messages.length === 0) return
			const lines: string[] = []
			if (!existsSync(file)) {
				mkdirSync(dirname(file), { recursive: true })
				const sessionHeader: SessionHeader = {
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: header.id,
					timestamp: new Date().toISOString(),
					cwd: header.cwd,
					parentSession: header.parentSession,
				}
				lines.push(JSON.stringify(sessionHeader))
				lastId = null
			} else {
				if (lastId === undefined) lastId = readEntries(file).findLast((entry) => entry.type === "message")?.id ?? null
				// A crash mid-write leaves a torn last line; start on a fresh line so the next entry stays parseable.
				if (!endsWithNewline(file)) lines.push("")
			}
			for (const message of messages) {
				const entry: SessionMessageEntry = {
					type: "message",
					id: randomUUID(),
					parentId: lastId ?? null,
					timestamp: new Date().toISOString(),
					message,
				}
				lines.push(JSON.stringify(entry))
				lastId = entry.id
			}
			// One write per append keeps each turn's entries together.
			appendFileSync(file, `${lines.join("\n")}\n`)
		},
	}
}

function readEntries(file: string): FileEntry[] {
	return existsSync(file) ? parseSessionEntries(readFileSync(file, "utf8")) : []
}

function endsWithNewline(file: string): boolean {
	const size = statSync(file).size
	if (size === 0) return true
	const fd = openSync(file, "r")
	try {
		const last = Buffer.alloc(1)
		readSync(fd, last, 0, 1, size - 1)
		return last[0] === 0x0a
	} finally {
		closeSync(fd)
	}
}
