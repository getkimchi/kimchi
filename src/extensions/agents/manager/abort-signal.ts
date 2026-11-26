import type { AgentSession } from "@earendil-works/pi-coding-agent"

export type AbortSessionTarget = Pick<AgentSession, "abort" | "abortBash">

/** Hard-abort both in-flight bash and the agent loop. Endpoint callers that only
 * aborted prompt generation cannot assume this kills a running subprocess. */
export function hardAbort(session: AbortSessionTarget): void {
	session.abortBash?.()
	session.abort()
}

/** Forward an active signal, including one already aborted while the session
 * was still being initialized. Registering a late listener alone would lose
 * that cancellation and let freshly bound tools start unauthorized work. */
export function forwardAbortSignal(session: AbortSessionTarget, signal?: AbortSignal): () => void {
	if (!signal) return () => {}
	const onAbort = () => hardAbort(session)
	if (signal.aborted) hardAbort(session)
	else signal.addEventListener("abort", onAbort, { once: true })
	return () => signal.removeEventListener("abort", onAbort)
}
