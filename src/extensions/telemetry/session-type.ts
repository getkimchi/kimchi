import { getActiveFerment } from "../ferment/index.js"
import { getTelemetryFermentV2Context } from "./ferment-v2-context.js"

export function getSessionType(): "ferment" | "coding" {
	if (getTelemetryFermentV2Context()) return "ferment"
	return getActiveFerment() ? "ferment" : "coding"
}
