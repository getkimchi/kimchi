import type { ClientCapabilities } from "@agentclientprotocol/sdk"

export const CAPABILITIES_KEY = "kimchi.dev"

// One entry per extension UI method. The key is the capability flag name
// (advertised via `_meta["kimchi.dev"][<key>] === true`) and the value is
// the wire method name (sent over extMethod / extNotification). Per-method
// flags let a client opt in to some and skip others — unsupported calls
// become `[ACP]` agent_message_chunk diagnostics instead of method-not-found.
export const AVAILABLE_METHODS = {
	pi_notify: `_${CAPABILITIES_KEY}/pi_notify`,
	pi_setStatus: `_${CAPABILITIES_KEY}/pi_setStatus`,
	pi_setWidget: `_${CAPABILITIES_KEY}/pi_setWidget`,
	pi_set_editor_text: `_${CAPABILITIES_KEY}/pi_set_editor_text`,
	pi_editor: `_${CAPABILITIES_KEY}/pi_editor`,
} as const

export type PiMethod = keyof typeof AVAILABLE_METHODS

export const ADVERTISED_CAPABILITIES: Record<PiMethod, boolean> = Object.keys(AVAILABLE_METHODS).reduce(
	(acc, method) => {
		acc[method as PiMethod] = true
		return acc
	},
	{} as Record<PiMethod, boolean>,
)

export const ALL_PI_METHODS: readonly PiMethod[] = Object.keys(AVAILABLE_METHODS) as PiMethod[]

export function getClientSupportsMethod(capabilities: ClientCapabilities | undefined, method: PiMethod): boolean {
	const flags = capabilities?._meta?.[CAPABILITIES_KEY] as Record<string, boolean> | undefined
	return flags?.[method] === true
}

// Presence-based on purpose: an empty `form: {}` is the documented way to
// declare elicitation support, so any non-null value is enough.
export function getClientSupportsElicitation(capabilities: ClientCapabilities | undefined): boolean {
	return capabilities?.elicitation?.form != null
}
