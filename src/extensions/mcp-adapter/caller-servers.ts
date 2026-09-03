import type { ServerEntry } from "./types.js"

/**
 * Session-id-keyed registry of caller-supplied MCP servers.
 *
 * The ACP server (`src/modes/acp/server.ts`) receives `mcpServers` on
 * `session/new` and `session/load` and needs to pass them to the MCP adapter
 * extension, which runs inside pi's `session_start` handler. Since pi's
 * `ExtensionContext` has no session-scoped channel for this, we use a
 * module-level map keyed by session ID.
 *
 * Keyed by sessionId (not a FIFO queue) so concurrent sessions can't consume
 * each other's entries. The ACP server calls `setCallerMcpServers(sessionId,
 * servers)` after the session is created (sessionId is known), and
 * `initializeMcp` calls `consumeCallerMcpServers(sessionId)` using
 * `ctx.sessionManager.getSessionId()`.
 */

const registry = new Map<string, Record<string, ServerEntry>>()

/**
 * Store caller-supplied MCP servers keyed by session ID.
 * Called by the ACP server after `sessionFactory`/`sessionLoader` returns
 * (when the session ID is known), before `bindAcpExtensions`.
 */
export function setCallerMcpServers(sessionId: string, servers: Record<string, ServerEntry>): void {
	registry.set(sessionId, servers)
}

/**
 * Pop and return the caller-supplied servers for the given session ID.
 * Called by `initializeMcp` during `session_start`. After consumption, the
 * entry is deleted — subsequent calls for the same sessionId return `{}`.
 */
export function consumeCallerMcpServers(sessionId: string): Record<string, ServerEntry> {
	const servers = registry.get(sessionId)
	if (servers) {
		registry.delete(sessionId)
		return servers
	}
	return {}
}

/**
 * Return the entry for a sessionId without removing it (for tests/debugging).
 */
export function peekCallerMcpServers(sessionId: string): Record<string, ServerEntry> | undefined {
	return registry.get(sessionId)
}

/**
 * Remove a specific session's entry if it hasn't been consumed yet.
 * Used by the ACP server's catch blocks to clean up after a session failure:
 * if `initializeMcp` already consumed the entry, this is a no-op.
 */
export function removePendingEntry(sessionId: string): void {
	registry.delete(sessionId)
}

/**
 * Clear the registry. Exposed for tests to ensure isolation between test cases.
 */
export function clearCallerMcpServers(): void {
	registry.clear()
}
