import type { ClientCapabilities } from "@agentclientprotocol/sdk"

export const CAPABILITIES_KEY = "kimchi.dev"

/**
 * RPC method names used by extension UI calls. Names mirror pi's
 * rpc-types.ts `RpcExtensionUIRequest` `method` field so clients that
 * already implement the JSONL subprocess protocol can reuse the same
 * dispatch table when talking to kimchi over ACP.
 *
 * Wire envelope for every method below:
 *   { type: "extension_ui_request", id, sessionId, method, ...payload }
 *
 * Dialogs use extMethod and expect an `extension_ui_response` reply;
 * fire-and-forget methods (notify/setStatus/setWidget/set_editor_text)
 * use extNotification with no reply. setTitle deliberately routes through
 * the ACP-native `session_info_update` channel rather than this namespace.
 */
export const AVAILABLE_METHODS = {
	pi: {
		confirm: `_${CAPABILITIES_KEY}/pi/confirm`,
		select: `_${CAPABILITIES_KEY}/pi/select`,
		input: `_${CAPABILITIES_KEY}/pi/input`,
		editor: `_${CAPABILITIES_KEY}/pi/editor`,
		notify: `_${CAPABILITIES_KEY}/pi/notify`,
		setStatus: `_${CAPABILITIES_KEY}/pi/setStatus`,
		setWidget: `_${CAPABILITIES_KEY}/pi/setWidget`,
		set_editor_text: `_${CAPABILITIES_KEY}/pi/set_editor_text`,
	},
} as const

/**
 * Capabilities advertised by kimchi via `_meta["kimchi.dev"]` in the
 * `initialize` response. Clients inspect these to decide whether to handle
 * extension UI RPCs (`_kimchi.dev/pi/*`) or fall back to behaviour where
 * dialogs resolve with their default-dismiss value (confirm → false,
 * select/input/editor → undefined).
 */
export const ADVERTISED_CAPABILITIES: Record<keyof typeof AVAILABLE_METHODS, boolean> = {
	pi: true,
} as const

export function getClientSupportsUiMethods(capabilities: ClientCapabilities | undefined): boolean {
	// Clients that support extension UI methods MUST set `_meta["kimchi.dev"].pi = true`.
	// The check is `flags.pi === true` (not `flags.ui`) because the namespace is
	// already the `pi` capability group — adding a sibling `ui` flag would just
	// be a second way to spell the same thing and invite drift.
	const flags = capabilities?._meta?.[CAPABILITIES_KEY] as Record<string, boolean> | undefined
	if (!flags) {
		return false
	}
	return flags.pi === true
}
