// Forward the pi-mono session events that describe WHY a turn is stalled.
// From the client's point of view an outstanding session/prompt with no
// updates is indistinguishable from a hang — but under the hood the agent may
// be waiting out a rate-limit deadline (auto_retry_*), running compaction
// (compaction_*), or retrying a failed summary (summarization_retry_*). None
// of these affect the transcript or turn outcome, so none fit a schema
// session-update type; they ride a kimchi.dev ext notification instead,
// carrying the sessionId explicitly (ext notifications are not session-scoped
// on the wire) so the client can pin the activity to the running stream.

import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { AVAILABLE_EXT_NOTIFICATIONS } from "./capabilities.js"

/** pi-mono event types forwarded as agent activity. Everything else is already
 * covered by schema session updates (messages, tools) or is internal-only. */
const FORWARDED_KINDS: ReadonlySet<string> = new Set([
	"auto_retry_start",
	"auto_retry_end",
	"compaction_start",
	"compaction_end",
	"summarization_retry_scheduled",
	"summarization_retry_attempt_start",
	"summarization_retry_finished",
])

/**
 * Fire-and-forget, like notifyDroppedQueue: a failed or unsupported ext
 * notification must never disturb the turn. Fields are forwarded verbatim so
 * future pi-mono event-shape additions (e.g. a stated rate-limit reopening
 * time) reach clients without a forwarding update here.
 */
export function emitAgentActivityUpdate(conn: AgentSideConnection, sessionId: string, event: AgentSessionEvent): void {
	if (!FORWARDED_KINDS.has(event.type)) return
	const { type, ...fields } = event as { type: string } & Record<string, unknown>
	conn.extNotification(AVAILABLE_EXT_NOTIFICATIONS.agent_activity, { sessionId, kind: type, ...fields }).catch(() => {})
}
