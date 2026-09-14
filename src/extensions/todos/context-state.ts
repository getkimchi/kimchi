import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerStateBlockPersistence } from "../state-block-persistence.js"
import { markHarnessSteer } from "../steer-marker.js"
import { renderTodoStateMarkdown } from "./state-markdown.js"
import { subscribeTodoStore } from "./store.js"

export const TODO_STATE_CUSTOM_TYPE = "todo-state"

/** Block persisted when the todo list is cleared after a state block was
 *  already persisted. Constant, so repeated clears dedupe. */
const TODO_CLEARED_MARKDOWN = "## Current Todos\n\nThe todo list was cleared."

function renderForPersist(sessionId: string): string | undefined {
	const markdown = renderTodoStateMarkdown(sessionId)
	return markdown === undefined ? undefined : markHarnessSteer(markdown)
}

/**
 * Persist-on-change delivery of the todo state block. Machinery (dedupe,
 * busy-run deferral, settle flush, history replay dedupe, strip-only
 * context view) lives in the shared `state-block-persistence` registrar —
 * see its module comment for the cache-breakpoint rationale.
 *
 * Todo-specific bits retained here: the render source (`renderTodoStateMarkdown`,
 * a pure function of the store), the cleared-list retraction marker
 * (history is append-only, so a cleared list must persist a fixed marker or
 * the strip-only view keeps showing stale todos), and the store
 * subscription as the change source.
 */
export function registerTodoStatePersistence(pi: ExtensionAPI): void {
	registerStateBlockPersistence(pi, {
		customType: TODO_STATE_CUSTOM_TYPE,
		render: (sessionId, previous) => {
			const content = renderForPersist(sessionId)
			if (content !== undefined) return content
			// The list was cleared after a block was persisted: retract it.
			return previous === undefined ? undefined : markHarnessSteer(TODO_CLEARED_MARKDOWN)
		},
		subscribe: (notify) => {
			subscribeTodoStore((_details, sessionId) => {
				notify(sessionId)
			})
		},
	})
}
