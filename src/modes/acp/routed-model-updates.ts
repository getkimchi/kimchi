// Mirror the auto-router's routed-model resolution entries to ACP clients as
// a `_kimchi.dev/routed_model` ext notification. The auto-model extension
// appends a `kimchi_routed_model_resolution` entry only when the backend's
// pick CHANGES (its own change-only dedup), so the notification inherits that
// exactly: one push per change, silence when a later turn lands on the same
// model. Clients that want per-turn labels keep per-session routing state,
// mirroring entry replay on reload. Unknown-model picks carry the backend's
// raw id, like the transcript notice does.

import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent"
import { isPersistedRoutedResolution, ROUTED_MODEL_RESOLUTION_ENTRY } from "../../extensions/auto-model/index.js"
import { AVAILABLE_EXT_NOTIFICATIONS } from "./capabilities.js"
import { emitExtNotification } from "./ext-notifications.js"

function routedPickOf(entry: SessionEntry): { requestedId: string; routedId: string } | undefined {
	if (entry.type !== "custom" || entry.customType !== ROUTED_MODEL_RESOLUTION_ENTRY) return undefined
	if (!isPersistedRoutedResolution(entry.data)) return undefined
	return { requestedId: entry.data.requestedId, routedId: entry.data.modelId }
}

/**
 * Fire-and-forget, like emitAgentActivityUpdate: a failed or unsupported ext
 * notification must never disturb the turn. Payload keys are built
 * explicitly (never spread from entry data) so a future entry field can
 * never clobber `sessionId`.
 */
export function emitRoutedModelUpdate(conn: AgentSideConnection, sessionId: string, event: AgentSessionEvent): void {
	if (event.type !== "entry_appended") return
	const pick = routedPickOf(event.entry)
	if (!pick) return
	emitExtNotification(conn, AVAILABLE_EXT_NOTIFICATIONS.routed_model, { ...pick, sessionId })
}
