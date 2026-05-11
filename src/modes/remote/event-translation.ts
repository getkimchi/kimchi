import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"

/**
 * Translate a low-level RPC `AgentEvent` (the wire event type pi-mono's
 * `--mode rpc` emits) into the higher-level `AgentSessionEvent` that
 * `InteractiveMode` subscribes to.
 *
 * The mapping is mostly 1:1 because `AgentSessionEvent` is defined as
 * `AgentEvent | ...session-specific extras...`.  Any event whose `type`
 * matches one of the core `AgentEvent` discriminants (or one of the
 * session-specific extras that the remote agent can legitimately emit) is
 * passed through; everything else returns `undefined` so callers can drop
 * unknown shapes safely.
 *
 * Returning `undefined` for unknown types keeps `InteractiveMode` shielded
 * from future server-side additions until we decide how to surface them.
 */

// Core AgentEvent discriminants (from @earendil-works/pi-agent-core).
const CORE_AGENT_EVENT_TYPES = new Set<string>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
])

// Session-specific extras on top of AgentEvent that the remote agent may emit.
const SESSION_EVENT_TYPES = new Set<string>([
	"queue_update",
	"compaction_start",
	"compaction_end",
	"session_info_changed",
	"thinking_level_changed",
	"auto_retry_start",
	"auto_retry_end",
])

/**
 * Minimal shape we accept from the wire.  We don't depend on the full
 * `AgentEvent` union here because the wire payload is `unknown` until
 * discriminated — see the cast at the return site.
 */
export interface RpcAgentEventLike {
	type: string
	[key: string]: unknown
}

export function translateRpcEvent(event: RpcAgentEventLike): AgentSessionEvent | undefined {
	if (CORE_AGENT_EVENT_TYPES.has(event.type) || SESSION_EVENT_TYPES.has(event.type)) {
		// Trust the wire: the server emits the same discriminated union the
		// local agent does.  We narrow at the boundary.
		return event as unknown as AgentSessionEvent
	}
	return undefined
}
