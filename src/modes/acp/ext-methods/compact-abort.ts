// ACP extension method handler for aborting an in-flight compaction.
//
// Wire name: `_kimchi.dev/compact_abort`, advertised via
// _meta["kimchi.dev"].compact_abort.
//
// Abort is a separate method rather than folded into `session/cancel`: cancel
// is the whole-turn kill switch (drains steer/follow-up queues, aborts the
// agent run), while compaction abort must stop only the summarization and
// leave the session immediately usable — the compaction-specific cancellation
// affordance Zed asks external agents to expose (zed discussion 57947).

import { RequestError } from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"

export type CompactAbortStatus = "aborted" | "notCompacting"

export type CompactAbortResponse = {
	status: CompactAbortStatus
}

/**
 * Abort handler for `_kimchi.dev/compact_abort`.
 *
 * Idempotent: a stale abort is the normal race (the client fires abort while
 * the compaction_end agent_activity notification is still in flight), so
 * nothing-to-abort resolves `notCompacting` instead of erroring. When a
 * compaction is in flight the handler delegates to
 * AgentSession.abortCompaction(); the terminal outcome still surfaces through
 * the compact method's `cancelled` response and the aborted compaction_end
 * activity notification.
 */
export async function handleCompactAbort(
	getSession: (sessionId: string) => AgentSession | undefined,
	params: Record<string, unknown>,
): Promise<CompactAbortResponse> {
	const sessionId = params.sessionId
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams(undefined, "sessionId is required and must be a non-empty string")
	}

	const session = getSession(sessionId)
	if (!session) {
		throw RequestError.invalidParams(undefined, `unknown sessionId ${sessionId}`)
	}

	if (!session.isCompacting) {
		return { status: "notCompacting" }
	}

	session.abortCompaction()
	return { status: "aborted" }
}
