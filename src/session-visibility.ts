import { open } from "node:fs/promises"
import { parseSessionEntries, type SessionInfo } from "@earendil-works/pi-coding-agent"

export const INTERNAL_SESSION_ENTRY = "kimchi:internal-session"

export interface InternalSessionInfo {
	kind: "ferment-evaluator" | "internal"
	model?: string
}

export async function getInternalSessionInfo(session: SessionInfo): Promise<InternalSessionInfo | undefined> {
	if (!session.parentSessionPath) return undefined
	let info: InternalSessionInfo | undefined
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
