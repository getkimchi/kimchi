import { getActiveFerment } from "../ferment/index.js"

export function getSessionType(): "ferment" | "coding" {
	return getActiveFerment() ? "ferment" : "coding"
}
