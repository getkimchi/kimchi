// Process-global registry of live per-session MCP reload handles (D3).
//
// Each pi session owns its own adapter instance, so a process-wide config
// apply fans out through one handle per live session. The adapter hands the
// handle to the host via McpAdapterOptions.reloadHandleSink after each
// successful initialization and revokes it on state shutdown (session
// replacement re-registers the replacement state's handle). The ACP ext
// method `_kimchi.dev/reload_mcp_config` iterates the live sessions and calls
// each record's handle; registry entries without a live SessionRecord are
// skipped by the caller, and records without a handle report no_extension.
//
// Module-level wiring, mirroring the MCP_STATUS_EVENT pattern: the registry
// is keyed by the per-session reload token the ACP server mints in
// createSessionSettings and drops when the session record is disposed. TUI
// sessions run the same extension without a registry consumer — registration
// without a token is a no-op.

import type { McpReloadHandle } from "pi-mcp-adapter/types"

const reloadHandles = new Map<string, McpReloadHandle>()

/** Registers (or replaces) the reload handle for a per-session token. */
export function registerReloadHandle(token: string, handle: McpReloadHandle): void {
	reloadHandles.set(token, handle)
}

/** Drops the reload handle for a token (adapter state shutdown / record disposal). */
export function unregisterReloadHandle(token: string): void {
	reloadHandles.delete(token)
}

/** Returns the live reload handle for a token, or undefined when none is registered. */
export function getReloadHandle(token: string): McpReloadHandle | undefined {
	return reloadHandles.get(token)
}

/** Clears every registered handle. Test seam only — production lifetime is per-token. */
export function clearReloadHandles(): void {
	reloadHandles.clear()
}
