/**
 * Cross-surface rating-window registry.
 *
 * The window arms when a response settles, is consumed by exactly one
 * accepted rating submission, and clears on the next turn start or a session
 * reset. Both feedback surfaces consult it: the TUI dialog flow (which also
 * keeps its own inviting/collecting state machine) and the ACP
 * `_kimchi.dev/feedback` ext-method — so it is keyed by sessionId, because the
 * ACP server runs multiple concurrent sessions in one process.
 *
 * Routed picks are recorded at settle time (`auto-beta` → `glm-5.3`) so
 * telemetry reports what the turn actually ran on, whatever the client sends.
 */

export type RatingWindow = {
	/** Whether the settled turn ran on the Auto model (a routed virtual model). */
	autoModelUsed: boolean
	/** The concrete routed pick (e.g. `glm-5.3`); undefined when auto wasn't used. */
	routedModelId: string | undefined
}

const windows = new Map<string, RatingWindow>()

/** Arms (or replaces) the window for a session — called when a response settles. */
export function armRatingWindow(sessionId: string, window: RatingWindow): void {
	windows.set(sessionId, window)
}

/** Reads the currently armed window, or undefined when no rating is available. */
export function getRatingWindow(sessionId: string): RatingWindow | undefined {
	return windows.get(sessionId)
}

/**
 * Removes and returns the window — the "one rating per settled response"
 * consumption. Call only after the submission was recorded.
 */
export function consumeRatingWindow(sessionId: string): RatingWindow | undefined {
	const window = windows.get(sessionId)
	windows.delete(sessionId)
	return window
}

/** Removes the window without recording a submission (turn/session reset, failed turn). */
export function clearRatingWindow(sessionId: string): void {
	windows.delete(sessionId)
}
