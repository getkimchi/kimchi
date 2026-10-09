import type { ClientCapabilities } from "@agentclientprotocol/sdk"

export const CAPABILITIES_KEY = "kimchi.dev"

// Wire method names for kimchi.dev extension methods. The key is the local
// identifier; the value is the method string sent over extMethod /
// extNotification. Entries are grouped by direction and scope:
//
// - agent→client: pi_* methods (the agent calls conn.extMethod on the client).
// - session-scoped inbound: require a live session, routed by sessionId
//   (the agent's extMethod() handler receives them).
// - sessionless inbound: no session involved (auth, onboarding, import,
//   trust reads/decisions that operate on paths or project state, resource
//   and memory store ops).
// - misc inbound: probe_mcp_server (SDK-era probing helper).
//
// project_trust_update is an agent→client extNotification (pushed after
//   session creation and whenever a trust decision changes), following the
//   queue_dropped precedent: not advertised in _meta (unaware clients ignore
//   unknown ext notifications per JSON-RPC rules), sessionId carried in the
//   payload because ext notifications are not session-scoped on the wire.
//
// Capability advertising: every entry here is exposed in
// `_meta["kimchi.dev"][<key>] === true` so clients can discover the methods
// the agent supports.
export const AVAILABLE_EXT_METHODS = {
	// Agent→client (outbound). The agent calls conn.extMethod on the client.
	pi_editor: `_${CAPABILITIES_KEY}/pi_editor`,

	// Session-scoped inbound — require a live session, routed by sessionId.
	set_session_title: `_${CAPABILITIES_KEY}/set_session_title`,
	steering: `_${CAPABILITIES_KEY}/steering`,
	compact: `_${CAPABILITIES_KEY}/compact`,
	compact_abort: `_${CAPABILITIES_KEY}/compact_abort`,
	memory_status: `_${CAPABILITIES_KEY}/memory_status`,
	set_memory_enabled: `_${CAPABILITIES_KEY}/set_memory_enabled`,

	// Sessionless inbound — no session involved.
	auth_status: `_${CAPABILITIES_KEY}/auth_status`,
	set_onboarding_flag: `_${CAPABILITIES_KEY}/set_onboarding_flag`,
	import_discover: `_${CAPABILITIES_KEY}/import_discover`,
	import_apply: `_${CAPABILITIES_KEY}/import_apply`,
	set_project_trust: `_${CAPABILITIES_KEY}/set_project_trust`,
	get_path_trust: `_${CAPABILITIES_KEY}/get_path_trust`,
	set_path_trust: `_${CAPABILITIES_KEY}/set_path_trust`,

	// Sessionless inbound, resources and memory store ops.
	list_resources: `_${CAPABILITIES_KEY}/list_resources`,
	set_resource_enabled: `_${CAPABILITIES_KEY}/set_resource_enabled`,
	memory_list: `_${CAPABILITIES_KEY}/memory_list`,
	memory_search: `_${CAPABILITIES_KEY}/memory_search`,
	memory_delete: `_${CAPABILITIES_KEY}/memory_delete`,
	memory_reset: `_${CAPABILITIES_KEY}/memory_reset`,

	// Misc inbound — standalone probing helper.
	probe_mcp_server: `_${CAPABILITIES_KEY}/probe_mcp_server`,
} as const

export const AVAILABLE_EXT_NOTIFICATIONS = {
	pi_notify: `_${CAPABILITIES_KEY}/pi_notify`,
	queue_dropped: `_${CAPABILITIES_KEY}/queue_dropped`,
	project_trust_update: `_${CAPABILITIES_KEY}/project_trust_update`,
	agent_activity: `_${CAPABILITIES_KEY}/agent_activity`,
} as const

export type AcpExtMethod = keyof typeof AVAILABLE_EXT_METHODS

export const ADVERTISED_CAPABILITIES: Record<AcpExtMethod, boolean> = Object.keys(AVAILABLE_EXT_METHODS).reduce(
	(acc, method) => {
		acc[method as AcpExtMethod] = true
		return acc
	},
	{} as Record<AcpExtMethod, boolean>,
)

export function getClientSupportsMethod(capabilities: ClientCapabilities | undefined, method: AcpExtMethod): boolean {
	const flags = capabilities?._meta?.[CAPABILITIES_KEY] as Record<string, boolean> | undefined
	return flags?.[method] === true
}

// Presence-based on purpose: an empty `form: {}` is the documented way to
// declare elicitation support, so any non-null value is enough.
export function getClientSupportsElicitation(capabilities: ClientCapabilities | undefined): boolean {
	return capabilities?.elicitation?.form != null
}
