/**
 * Per-session ferment state.
 *
 * The ferment extension is bound once per session (CLI, ACP, or subagent).
 * Session-scoped state — the active ferment, continuation policy, judge context,
 * and active-ferment change listeners — must not leak across sessions. This
 * module isolates that state and provides a registry so cross-cutting code that
 * does not receive a runtime can still look up the state for a specific
 * session ID.
 */

import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import type { Ferment } from "../../ferment/types.js"
import type { ContinuationPolicy } from "./state.js"

export interface FermentSessionState {
	activeFerment: Ferment | undefined
	continuationPolicy: ContinuationPolicy
	lastHumanInputAt: Date | undefined
	judgeModel: Model<Api> | undefined
	judgeModelRegistry: ModelRegistry | undefined
	activeFermentChangeListener: ((hasActive: boolean) => void) | undefined
}

export function createFermentSessionState(): FermentSessionState {
	return {
		activeFerment: undefined,
		continuationPolicy: "manual",
		lastHumanInputAt: undefined,
		judgeModel: undefined,
		judgeModelRegistry: undefined,
		activeFermentChangeListener: undefined,
	}
}

/** Default singleton state — used by legacy tests and global accessors. */
export const defaultFermentSessionState = createFermentSessionState()

// ─── Session registry ───────────────────────────────────────────────────────
//
// The registry lets non-ferment code (status line, telemetry, permissions,
// surveys, etc.) retrieve the ferment state for the session they are running
// in. Registration/unregistration is owned by the ferment extension factory so
// the lifetime matches the bound extension instance.

const sessionStateById = new Map<string, FermentSessionState>()

export function registerFermentSessionState(sessionId: string, state: FermentSessionState): void {
	sessionStateById.set(sessionId, state)
}

export function unregisterFermentSessionState(sessionId: string): void {
	sessionStateById.delete(sessionId)
}

export function getFermentSessionState(sessionId?: string): FermentSessionState {
	if (sessionId) {
		const registered = sessionStateById.get(sessionId)
		if (registered) return registered
	}
	return defaultFermentSessionState
}

export function clearFermentSessionStateRegistry(): void {
	sessionStateById.clear()
}
