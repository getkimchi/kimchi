import { open } from "node:fs/promises"
import { parseSessionEntries, type SessionInfo } from "@earendil-works/pi-coding-agent"

export const INTERNAL_SESSION_ENTRY = "kimchi:internal-session"

export const SUBAGENT_SESSION_ENTRY = "kimchi:subagent-session"

export type SessionRoleInfo = ({ kind: "ferment-evaluator" | "internal" } | { kind: "subagent"; name: string }) & {
	model?: string
}

export async function getSessionRoles(sessions: SessionInfo[]): Promise<Map<SessionInfo, SessionRoleInfo>> {
	const roles = new Map<SessionInfo, SessionRoleInfo>()
	const parents = new Map<string, Map<string, SessionInfo>>()
	for (const session of sessions) {
		const role = await getSessionRoleInfo(session)
		if (role) roles.set(session, role)
		else if (session.parentSessionPath) {
			let children = parents.get(session.parentSessionPath)
			if (!children) {
				children = new Map()
				parents.set(session.parentSessionPath, children)
			}
			children.set(session.path, session)
		}
	}
	// Older children saved their role only in the parent's subagent record.
	// Stream each needed parent once, including parents outside the current scope.
	for (const [path, children] of parents) {
		try {
			const file = await open(path, "r")
			try {
				for await (const line of file.readLines({ autoClose: false })) {
					if (!line.includes('"subagents:record"')) continue
					const entry = parseSessionEntries(line)[0]
					if (entry?.type !== "custom" || entry.customType !== "subagents:record") continue
					const data = entry.data
					if (
						typeof data !== "object" ||
						data === null ||
						!("sessionFile" in data) ||
						typeof data.sessionFile !== "string" ||
						!("type" in data) ||
						typeof data.type !== "string" ||
						!data.type.trim()
					)
						continue
					const child = children.get(data.sessionFile)
					if (child) roles.set(child, { kind: "subagent", name: data.type })
				}
			} finally {
				await file.close()
			}
		} catch {
			// Missing parents leave their children visible without an inferred role.
		}
	}
	return roles
}

export async function getSessionRoleInfo(session: SessionInfo): Promise<SessionRoleInfo | undefined> {
	if (!session.parentSessionPath) return undefined
	let info: SessionRoleInfo | undefined
	// Older evaluator files predate the marker. Require their full identifying
	// shape rather than treating every branch or similarly named session as internal.
	if (
		session.name === "Ferment V2 evaluator" &&
		session.firstMessage.startsWith("Objective:\n") &&
		session.firstMessage.includes("\n\nCurrent Todo state:\n") &&
		session.firstMessage.includes("\n\nDurable Ferment V2 lessons:\n")
	)
		info = { kind: "ferment-evaluator" }
	try {
		const file = await open(session.path, "r")
		try {
			// The marker is immediately after the header. Bound the read so ordinary
			// branches with a large first message never require a second transcript scan.
			const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(16_384), position: 0 })
			const entries = parseSessionEntries(buffer.toString("utf8", 0, bytesRead))
			const marker = entries[1]
			if (marker?.type === "custom" && marker.customType === INTERNAL_SESSION_ENTRY) {
				const data = marker.data
				info = {
					kind:
						typeof data === "object" && data !== null && "kind" in data && data.kind === "ferment-evaluator"
							? "ferment-evaluator"
							: "internal",
				}
			}
			if (marker?.type === "custom" && marker.customType === SUBAGENT_SESSION_ENTRY) {
				const data = marker.data
				if (
					typeof data === "object" &&
					data !== null &&
					"type" in data &&
					typeof data.type === "string" &&
					data.type.trim()
				) {
					info = { kind: "subagent", name: data.type }
				}
			}
			const model = entries.find((entry) => entry.type === "model_change")
			if (info && model) info.model = `${model.provider}/${model.modelId}`
		} finally {
			await file.close()
		}
	} catch {
		// An unreadable or concurrently removed session must not hide another file.
	}
	return info
}
