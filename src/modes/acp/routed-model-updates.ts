// Mirror the auto-router's routed-model resolution entries to ACP clients as
// a `_kimchi.dev/routed_model` ext notification. The auto-model extension
// appends a `kimchi_routed_model_resolution` entry only when the backend's
// pick CHANGES (its own change-only dedup), so the notification inherits that
// exactly: one push per change, silence when a later turn lands on the same
// model. Clients that want per-turn labels keep per-session routing state,
// mirroring entry replay on reload. Unknown-model picks carry the backend's
// raw id, like the transcript notice does.

import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { isRoutedResolutionEntry } from "../../extensions/auto-model/index.js"
import { AVAILABLE_EXT_NOTIFICATIONS } from "./capabilities.js"
import { emitExtNotification } from "./ext-notifications.js"

/**
 * Fire-and-forget, like emitAgentActivityUpdate: a failed or unsupported ext
 * notification must never disturb the turn. Payload keys are built
 * explicitly (never spread from entry data) so a future entry field can
 * never clobber `sessionId`; `routedId` is the wire name for the entry's
 * `modelId`, matching the frozen consumer contract.
 */
export function emitRoutedModelUpdate(conn: AgentSideConnection, sessionId: string, event: AgentSessionEvent): void {
	if (event.type !== "entry_appended") return
	if (!isRoutedResolutionEntry(event.entry)) return
	const { requestedId, modelId } = event.entry.data
	emitExtNotification(conn, AVAILABLE_EXT_NOTIFICATIONS.routed_model, { requestedId, routedId: modelId, sessionId })
}
