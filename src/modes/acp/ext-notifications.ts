// Shared fire-and-forget tail for agent→client ext notifications: a failed
// or unsupported notification must never disturb the turn, and not awaiting
// preserves ordering (the ACP SDK serializes outbound writes). Dropped
// delivery is a client-visible stall, so log it for the operator.

import type { AgentContext } from "@agentclientprotocol/sdk/unstable"

export function emitExtNotification(conn: AgentContext, method: string, params: Record<string, unknown>): void {
	conn.notify(method, params).catch((err: unknown) => {
		process.stderr.write(`acp ${method} notification failed: ${String(err)}\n`)
	})
}
