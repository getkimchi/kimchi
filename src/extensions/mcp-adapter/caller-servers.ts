import type { ServerEntry } from "./types.js"

/**
 * Process-level FIFO registry of caller-supplied MCP servers.
 *
 * The ACP server (`src/modes/acp/server.ts`) receives `mcpServers` on
 * `session/new` and `session/load` and needs to pass them to the MCP adapter
 * extension, which runs inside pi's `session_start` handler. Since pi's
 * `ExtensionContext` has no session-scoped channel for this, we use a
 * module-level queue: `setCallerMcpServers` pushes, `consumeCallerMcpServers`
 * pops (FIFO).
 *
 * FIFO order matters: `initializeMcp` is fire-and-forget relative to
 * `bindExtensions`, so two rapid `newSession` calls can overlap. The queue
 * ensures each `session_start` → `initializeMcp` consumes the servers that
 * were set for that specific session, in call order.
 */

/**
 * Internal queue entry. The `servers` field holds the actual server definitions;
 * the object identity (reference) is used by `removePendingEntry` to safely
 * remove only the entry that this specific `setCallerMcpServers` call created,
 * without accidentally draining a different session's entry.
 */
export interface CallerServerEntry {
	servers: Record<string, ServerEntry>
}

const queue: CallerServerEntry[] = []

/**
 * Push caller-supplied MCP servers onto the registry queue.
 * Returns the opaque entry so the caller can remove it later if the session
 * fails before `initializeMcp` consumes it.
 */
export function setCallerMcpServers(servers: Record<string, ServerEntry>): CallerServerEntry {
	const entry: CallerServerEntry = { servers }
	queue.push(entry)
	return entry
}

/**
 * Pop and return the oldest caller-supplied servers from the queue.
 * Called by `initializeMcp` during `session_start`. After consumption, the
 * entry is gone — subsequent calls return `{}` until the next `setCallerMcpServers`.
 */
export function consumeCallerMcpServers(): Record<string, ServerEntry> {
	return queue.shift()?.servers ?? {}
}

/**
 * Return the oldest entry without removing it (for tests/debugging).
 */
export function peekCallerMcpServers(): Record<string, ServerEntry> | undefined {
	return queue[0]?.servers
}

/**
 * Remove a specific pending entry from the queue if it hasn't been consumed yet.
 * Used by the ACP server's catch blocks to clean up after a session failure:
 * if `initializeMcp` already consumed the entry (via `consumeCallerMcpServers`),
 * this is a no-op. If it hasn't (e.g. `sessionFactory` threw before
 * `session_start` fired), the entry is removed so it doesn't leak to the next
 * session.
 *
 * Uses reference identity (`===`) so it only removes the exact entry returned
 * by `setCallerMcpServers`, never a different session's entry.
 */
export function removePendingEntry(entry: CallerServerEntry): void {
	const index = queue.indexOf(entry)
	if (index !== -1) {
		queue.splice(index, 1)
	}
}

/**
 * Clear the queue. Exposed for tests to ensure isolation between test cases.
 */
export function clearCallerMcpServers(): void {
	queue.length = 0
}
