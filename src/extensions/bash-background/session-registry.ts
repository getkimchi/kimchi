/**
 * Session-scoped background-bash state accessor.
 *
 * Lives in its own module (not the `./index.js` barrel) so consumers like
 * `bash-control-tool.ts` and `bash-control-extension.ts` don't import the
 * barrel — which would make the folder's module graph bidirectional.
 *
 * Lifecycle: `bashBackgroundExtension` (index.ts) installs fresh state on
 * `session_start` and clears it on `session_shutdown` after draining it.
 */
import type { ProcessRegistry } from "./process-registry.js"
import type { ReviewCoordinator } from "./review-coordinator.js"

/** Everything a session's background-bash cohort needs: processes + clock. */
export interface BashSessionState {
	registry: ProcessRegistry
	coordinator: ReviewCoordinator
	/** Absolute per-process safety limit in seconds (operator-configured). */
	limitSeconds: number
	/**
	 * Session working directory. Used to render process cwd facts
	 * project-relative when a process runs elsewhere.
	 */
	cwd?: string
	/**
	 * Delivers a due cohort review to the model. Installed by the
	 * bash-control extension on session_start; the coordinator invokes it
	 * when no active `bash_control(wait: true)` claims the review. Always
	 * resolves (never rejects): delivery failures are logged and the
	 * pending-review slot is released by the extension itself.
	 */
	deliverReview?: (() => Promise<void>) | undefined
}

let sessionState: BashSessionState | undefined

/** The active session's background-bash state, or undefined outside a session. */
export function getSessionState(): BashSessionState | undefined {
	return sessionState
}

/** Install (or clear) the session-scoped state. Owned by bashBackgroundExtension. */
export function setSessionState(state: BashSessionState | undefined): void {
	sessionState = state
}
