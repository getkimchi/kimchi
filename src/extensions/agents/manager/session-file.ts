import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { CURRENT_SESSION_VERSION, type CustomEntry, type SessionHeader } from "@earendil-works/pi-coding-agent"
import { v7 as uuidv7 } from "uuid"
import { SUBAGENT_SESSION_ENTRY } from "../../../session-visibility.js"

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
	agentType: string,
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
	const role: CustomEntry<{ type: string }> = {
		type: "custom",
		id: uuidv7(),
		parentId: null,
		timestamp,
		customType: SUBAGENT_SESSION_ENTRY,
		data: { type: agentType },
	}
	writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(role)}\n`, { mode: 0o600 })
	return { sessionId, sessionFile }
}
