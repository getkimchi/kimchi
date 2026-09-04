import type { ClientCapabilities } from "@agentclientprotocol/sdk"

export const CAPABILITIES_KEY = "kimchi.dev"

// Wire method names for kimchi.dev extension methods. The key is the local
// identifier; the value is the method string sent over extMethod /
// extNotification.
//
// Direction:
// - pi_* methods are agent→client (the agent calls conn.extMethod on the client).
// - probe_mcp_server, set_session_title, and steering are client→agent
//   inbound (the agent's extMethod() handler receives them).
//
// Capability advertising: every entry here is exposed in
// `_meta["kimchi.dev"][<key>] === true` so clients can discover the methods
// the agent supports.
export const AVAILABLE_EXT_METHODS = {
	pi_editor: `_${CAPABILITIES_KEY}/pi_editor`,
	probe_mcp_server: `_${CAPABILITIES_KEY}/probe_mcp_server`,
	set_session_title: `_${CAPABILITIES_KEY}/set_session_title`,
	steering: `_${CAPABILITIES_KEY}/steering`,
} as const

export const AVAILABLE_EXT_NOTIFICATIONS = {
	pi_notify: `_${CAPABILITIES_KEY}/pi_notify`,
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
