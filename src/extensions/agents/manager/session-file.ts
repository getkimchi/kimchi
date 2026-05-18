import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@earendil-works/pi-coding-agent"
import { v7 as uuidv7 } from "uuid"

export interface AgentSessionFile {
	sessionId: string
	sessionFile: string
}

/**
 * Pre-write a child Agent session header so the in-process Agent runner can open
 * a persisted session with a parentSession backlink to the spawning session.
 */
export function prepareAgentSessionFile(
	parentSessionDir: string,
	parentSessionFile: string | undefined,
	cwd: string,
	generateId: () => string = uuidv7,
	now: () => Date = () => new Date(),
): AgentSessionFile | undefined {
	if (parentSessionFile === undefined || parentSessionDir.length === 0) return undefined

	const sessionId = generateId()
	const timestamp = now().toISOString()
	const sessionFile = join(parentSessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`)
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionId,
		timestamp,
		cwd,
		parentSession: parentSessionFile,
	}
	writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { mode: 0o600 })
	return { sessionId, sessionFile }
}
