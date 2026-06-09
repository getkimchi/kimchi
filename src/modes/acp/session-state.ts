/**
 * Per-session multi-model state for ACP mode.
 *
 * ACP supports multiple concurrent sessions, each with its own model mode
 * (single-model vs multi-model). This module owns the session-scoped storage
 * and the AsyncLocalStorage context that lets extensions read the correct
 * per-session flag without an explicit session parameter.
 *
 * CLI mode does not use this module — it relies on the global flag in
 * prompt-enrichment.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import type { AgentSession } from "@earendil-works/pi-coding-agent"

// ---------------------------------------------------------------------------
// AsyncLocalStorage context — concurrency-safe session pointer
// ---------------------------------------------------------------------------

const sessionStorage = new AsyncLocalStorage<AgentSession | null>()

/**
 * Run `fn` with `session` as the active session context.
 * Extensions called during `fn` can read per-session state via
 * {@link getCurrentSessionId}.
 */
export function runWithSession<T>(session: AgentSession | null, fn: () => T): T {
	return sessionStorage.run(session, fn)
}

/**
 * Return the sessionId of the current ACP session, or `null` when running
 * outside an ACP prompt context (e.g. CLI mode).
 */
export function getCurrentSessionId(): string | null {
	return sessionStorage.getStore()?.sessionId ?? null
}

// ---------------------------------------------------------------------------
// Per-session multi-model flag — keyed by sessionId
// ---------------------------------------------------------------------------

const sessionMultiModelState = new Map<string, boolean>()

export function getSessionMultiModelEnabled(sessionId: string): boolean {
	return sessionMultiModelState.get(sessionId) ?? false
}

export function setSessionMultiModelEnabled(sessionId: string, enabled: boolean): void {
	sessionMultiModelState.set(sessionId, enabled)
}

/**
 * Remove per-session state when a session is destroyed.
 * Call during ACP session cleanup to prevent Map growth.
 */
export function clearSessionMultiModelState(sessionId: string): void {
	sessionMultiModelState.delete(sessionId)
}
