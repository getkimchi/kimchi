/**
 * Plan-review "closed without a follow-up turn" notifier.
 *
 * pi-mono session events cover almost the whole plan-review lifecycle — the review
 * window opens with submit_plan's tool_execution_end and an approved execution starts
 * with the next agent_start — but a review that ends WITHOUT dispatching a follow-up
 * turn (the user picks "Rework the plan", or dismisses the review menu) leaves no
 * observable trace on the session.
 *
 * Consumers that hold state across the review (the ACP server holds the originating
 * prompt open so execution lands inside it) need that single missing fact. Extensions
 * that own the review UI call notifyPlanReviewClosed(sessionId) at their
 * no-follow-up-turn exits; listeners (surfaces) subscribe here. Surface-agnostic:
 * mirroring the todo-store/AcpPlanTracker pattern, this module knows nothing about TUI
 * or ACP, and permissions knows nothing about its listeners.
 */

export type PlanReviewClosedListener = (sessionId: string) => void

const closedListeners = new Set<PlanReviewClosedListener>()

/** Signal that a plan review for the given session ended WITHOUT dispatching a
 * follow-up turn (rework / dismissal — not an execution decision). */
export function notifyPlanReviewClosed(sessionId: string): void {
	for (const listener of closedListeners) {
		listener(sessionId)
	}
}

/** Register a listener for plan-review closed notifications. Returns an unsubscribe
 * function. Listeners fire synchronously, in registration order. */
export function subscribePlanReviewClosed(listener: PlanReviewClosedListener): () => void {
	closedListeners.add(listener)
	return () => {
		closedListeners.delete(listener)
	}
}

/** Test hook: remove all registered listeners. */
export function resetPlanReviewClosedListenersForTests(): void {
	closedListeners.clear()
}
