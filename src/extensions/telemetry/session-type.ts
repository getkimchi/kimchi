import { getActiveFerment } from "../ferment/index.js"

export function getSessionType(sessionId?: string): "ferment" | "coding" {
	return getActiveFerment(sessionId) ? "ferment" : "coding"
}
