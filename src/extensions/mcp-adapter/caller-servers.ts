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

const queue: Array<Record<string, ServerEntry>> = []

/**
 * Push caller-supplied MCP servers onto the registry queue.
 * Called by the ACP server before `bindAcpExtensions` so the
 * `session_start` handler picks them up.
 */
export function setCallerMcpServers(servers: Record<string, ServerEntry>): void {
	queue.push(servers)
}

/**
 * Pop and return the oldest caller-supplied servers from the queue.
 * Called by `initializeMcp` during `session_start`. After consumption, the
 * entry is gone — subsequent calls return `{}` until the next `setCallerMcpServers`.
 */
export function consumeCallerMcpServers(): Record<string, ServerEntry> {
	return queue.shift() ?? {}
}

/**
 * Return the oldest entry without removing it (for tests/debugging).
 */
export function peekCallerMcpServers(): Record<string, ServerEntry> | undefined {
	return queue[0]
}

/**
 * Clear the queue. Exposed for tests to ensure isolation between test cases.
 */
export function clearCallerMcpServers(): void {
	queue.length = 0
}
