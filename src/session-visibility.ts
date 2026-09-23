import { open } from "node:fs/promises"
import type { SessionInfo } from "@earendil-works/pi-coding-agent"

export const INTERNAL_SESSION_ENTRY = "kimchi:internal-session"

export async function isInternalSession(session: SessionInfo): Promise<boolean> {
	if (!session.parentSessionPath) return false
	// Older evaluator files predate the marker. Require their full identifying
	// shape rather than treating every branch or similarly named session as internal.
	if (
		session.name === "Ferment V2 evaluator" &&
		session.firstMessage.startsWith("Objective:\n") &&
		session.firstMessage.includes("\n\nCurrent Todo state:\n") &&
		session.firstMessage.includes("\n\nDurable Ferment V2 lessons:\n")
	)
		return true
	try {
		const file = await open(session.path, "r")
		try {
			// The marker is immediately after the header. Bound the read so ordinary
			// branches with a large first message never require a second transcript scan.
			const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(16_384), position: 0 })
			const marker = buffer.toString("utf8", 0, bytesRead).split("\n", 3)[1]
			if (!marker) return false
			const entry = JSON.parse(marker)
			return entry.type === "custom" && entry.customType === INTERNAL_SESSION_ENTRY
		} finally {
			await file.close()
		}
	} catch {
		// An unreadable or concurrently removed session must not hide another file.
		return false
	}
}
