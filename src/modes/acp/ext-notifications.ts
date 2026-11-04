// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
// Shared fire-and-forget tail for agent→client ext notifications: a failed
// or unsupported notification must never disturb the turn, and not awaiting
// preserves ordering (the ACP SDK serializes outbound writes). Dropped
// delivery is a client-visible stall, so log it for the operator.

import type { AgentSideConnection } from "@agentclientprotocol/sdk"

export function emitExtNotification(conn: AgentSideConnection, method: string, params: Record<string, unknown>): void {
	conn.extNotification(method, params).catch((err: unknown) => {
		process.stderr.write(`acp ${method} notification failed: ${String(err)}\n`)
	})
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
