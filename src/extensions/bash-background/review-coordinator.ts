// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/**
 * Cohort lifecycle coordinator for background bash.
 *
 * Owns per-command handoff deadlines and the bounded checkpoint waits of
 * explicit `bash_control(wait: true)` calls. There is NO recurring clock:
 * while the agent does independent work, nothing wakes the model — exits
 * are delivered by the extension, and time only passes for a wait that
 * the model explicitly requested.
 *
 *  - Initial handoff (≤ `handoffSeconds`, default 15s): a one-time,
 *    per-command deadline for the `bash` tool call that spawned the
 *    process. When the process is still running at the deadline, `bash`
 *    resolves with the handle and unseen output. Every command gets its
 *    OWN handoff deadline — joiners never share or reset one. In
 *    user-facing sessions a queued user message hands off early, once the
 *    command has had `MIN_HANDOFF_SECONDS` to finish on its own.
 *  - Cohort wait (`awaitCohortEvent`): blocks until the first cohort
 *    exit (including joiners), the wait's bounded checkpoint (the
 *    effective duration validated by the caller, capped at
 *    `MAX_WAIT_SECONDS`), pending automatic delivery, a queued user
 *    message (only when the caller supplies a pending-user-message check
 *    — user-facing executions), abort, or cohort disposal. The
 *    checkpoint timer starts when the actual wait begins — after any requested
 *    stops were applied — and joining handles never postpone it.
 *
 * Exit observation uses ONE permanent `whenExited` continuation per
 * tracked handle (registered on `handleSpawned`) that dispatches to the
 * current handoff waiter and the current active wait. Sequential waits
 * on the same long-lived command therefore never accumulate promise
 * listeners.
 *
 * The coordinator also owns the model-monitoring history for the cohort:
 * consecutive-checkpoint streaks per process. A streak counts
 * wait-timeout responses that reported the process; any inspection or
 * cohort terminal-event response reported by `bash_control` resets it.
 * Removing a handle deletes its history.
 *
 * This module is intentionally free of any `ExtensionAPI` dependency so
 * it stays unit-testable with fake timers.
 */
import type { ProcessRegistry } from "./process-registry.js"
import type { TerminalDelivery } from "./terminal-delivery.js"

/**
 * One-time per-command handoff deadline (seconds). Sized from trace data:
 * ~90% of bash commands finish within 15s (75% within 2s), and most of
 * those between 2s and 15s are tests and builds whose result the agent
 * wants immediately — handing them off would only add a round trip.
 */
export const INITIAL_HANDOFF_SECONDS = 15

/**
 * Minimum time a command runs before a queued user message may release
 * its handoff early, so quick commands still return a normal result.
 */
export const MIN_HANDOFF_SECONDS = 2

/** Default bounded wait duration (seconds) when `waitSeconds` is omitted. */
export const DEFAULT_WAIT_SECONDS = 300

/** Harness-enforced maximum wait duration (seconds) per call. */
export const MAX_WAIT_SECONDS = 600

/**
 * Polling interval (milliseconds) for the pending-user-input check of a
 * user-facing wait. Short enough that a queued user message releases the
 * wait well within the 100 ms responsiveness target, cheap enough to run
 * for the whole bounded wait without measurable cost. Exported for tests.
 */
export const USER_INPUT_POLL_MS = 50

export type HandoffResult = "exited" | "handoff" | "aborted"

export type CohortWaitEvent =
	| { kind: "exit"; handle: string }
	| { kind: "checkpoint" }
	| { kind: "aborted" }
	| { kind: "empty" }
	| { kind: "pending-delivery" }
	| { kind: "user-input" }

export interface ReviewCoordinatorOptions {
	registry: ProcessRegistry
	/** Test override for the initial handoff deadline (seconds). */
	handoffSeconds?: number
	/** Test override for the minimum runtime before user input releases a handoff (seconds). */
	minHandoffSeconds?: number
	/** Test override for the default bounded wait duration (seconds). */
	waitSeconds?: number
}

export interface ReviewCoordinator {
	/** Join `handle` to the cohort and observe its exit. */
	handleSpawned(handle: string): void
	/** Remove `handle` from the cohort and forget its monitoring history. */
	handleRemoved(handle: string): void
	/**
	 * Resolve when the freshly spawned `handle` reaches its one-time
	 * handoff deadline ("handoff"), its process exits ("exited"), or the
	 * provided signal aborts ("aborted"). `hasPendingUserInput` (supplied by
	 * user-facing executions only) hands off early once a user message is
	 * queued and the command has run for the minimum handoff time.
	 */
	awaitInitialHandoff(handle: string, signal?: AbortSignal, hasPendingUserInput?: () => boolean): Promise<HandoffResult>
	/**
	 * Claim the single concurrent cohort-wait slot. Returns `{ ok: false }`
	 * when another `bash_control(wait: true)` is already active.
	 */
	beginCohortWait(toolCallId: string): { ok: true } | { ok: false; error: string }
	/**
	 * Block until the first cohort exit (joiners included), the bounded
	 * checkpoint (starting NOW, for `waitSeconds` seconds), pending
	 * automatic delivery, a queued user message (`hasPendingUserInput`
	 * supplied by user-facing executions only), abort, or cohort disposal.
	 * Must be paired with `beginCohortWait`/`endCohortWait`.
	 */
	awaitCohortEvent(
		toolCallId: string,
		signal?: AbortSignal,
		waitSeconds?: number,
		delivery?: TerminalDelivery,
		hasPendingUserInput?: () => boolean,
	): Promise<CohortWaitEvent>
	/** Release the cohort-wait slot without awaiting further events. */
	endCohortWait(toolCallId: string): void
	/** Whether a `bash_control(wait: true)` currently owns the wait slot. */
	hasActiveWait(): boolean
	/** Number of handles currently in the cohort. */
	readonly size: number
	/** Snapshot of the handle ids currently in the cohort. */
	handles(): string[]
	/** Current consecutive-checkpoint streak for `handle` (0 when unknown). */
	getCheckpointStreak(handle: string): number
	/**
	 * Commit a wait-timeout outcome: increment the streak of every
	 * reported running process (only processes a checkpoint response
	 * actually reported).
	 */
	commitWaitTimeout(reportedRunning: readonly string[]): void
	/**
	 * Commit an observation response (immediate inspection or a cohort
	 * terminal-event response): reset the streak of every reported
	 * running process.
	 */
	commitObservation(reportedRunning: readonly string[]): void
	/** Cancel every timer and listener without resolving waiters. */
	dispose(): void
}

export function createReviewCoordinator(options: ReviewCoordinatorOptions): ReviewCoordinator {
	const registry = options.registry
	const handoffSeconds = options.handoffSeconds ?? INITIAL_HANDOFF_SECONDS
	const minHandoffSeconds = Math.min(options.minHandoffSeconds ?? MIN_HANDOFF_SECONDS, handoffSeconds)
	const defaultWaitSeconds = options.waitSeconds ?? DEFAULT_WAIT_SECONDS

	const handles = new Set<string>()
	// Consecutive-checkpoint streaks per tracked handle (model-monitoring
	// history owned by the coordinator, deleted with the handle).
	const checkpointStreaks = new Map<string, number>()

	interface HandoffWaiter {
		resolve: (result: HandoffResult) => void
		timer: NodeJS.Timeout | undefined
		/** Delay before user-input polling starts, then the polling interval. */
		inputTimer: NodeJS.Timeout | undefined
		onAbort: (() => void) | undefined
		signal: AbortSignal | undefined
		settled: boolean
	}
	const handoffWaiters = new Map<string, HandoffWaiter>()

	interface ActiveWait {
		toolCallId: string
		resolve: (event: CohortWaitEvent) => void
		cleanup: (() => void) | undefined
		/**
		 * Installed by `awaitCohortEvent`: the guarded entry point through
		 * which handle exits, the checkpoint timer, and abort resolve the
		 * wait. Undefined for a never-awaited slot and cleared when the
		 * wait settles or is released, so late callbacks become no-ops.
		 */
		settle?: (event: CohortWaitEvent) => void
	}
	let activeWait: ActiveWait | undefined

	/**
	 * Dispatch one handle's natural exit to its current handoff waiter and
	 * the current active wait. Registered exactly once per handle (on
	 * `handleSpawned`) so repeated waits never accumulate `whenExited`
	 * continuations.
	 */
	function notifyExit(handle: string): void {
		const waiter = handoffWaiters.get(handle)
		if (waiter) settleHandoffWaiter(handle, waiter, "exited")
		// Only a handle still IN the cohort resolves the active wait — a
		// handle removed by a concurrent collection belongs to that call.
		if (handles.has(handle)) activeWait?.settle?.({ kind: "exit", handle })
	}

	function settleHandoffWaiter(handle: string, waiter: HandoffWaiter, result: HandoffResult): void {
		if (waiter.settled) return
		waiter.settled = true
		if (waiter.timer) clearTimeout(waiter.timer)
		if (waiter.inputTimer) clearTimeout(waiter.inputTimer)
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort)
		handoffWaiters.delete(handle)
		waiter.resolve(result)
	}

	function handleSpawned(handle: string): void {
		const wasTracked = handles.has(handle)
		handles.add(handle)
		if (wasTracked) return
		// One permanent exit observer per handle: dispatches to the current
		// handoff waiter and the current active wait whenever the process
		// ends (natural exit, stop, safety limit — any exec settlement).
		void registry
			.whenExited(handle)
			.then(() => notifyExit(handle))
			.catch(() => notifyExit(handle))
	}

	function handleRemoved(handle: string): void {
		handles.delete(handle)
		checkpointStreaks.delete(handle)
		const waiter = handoffWaiters.get(handle)
		if (waiter) settleHandoffWaiter(handle, waiter, "exited")
		// Removing the last handle must not strand a waiter until its
		// deadline: settle it now. If the wait already resolved on the
		// handle's exit, the settle guard makes this a no-op.
		if (handles.size === 0 && activeWait?.settle) {
			activeWait.settle({ kind: "empty" })
		}
	}

	function awaitInitialHandoff(
		handle: string,
		signal?: AbortSignal,
		hasPendingUserInput?: () => boolean,
	): Promise<HandoffResult> {
		const entry = registry.getEntry(handle)
		if (entry?.state !== "running") return Promise.resolve("exited")

		const waiter: HandoffWaiter = {
			resolve: () => {},
			timer: undefined,
			inputTimer: undefined,
			onAbort: undefined,
			signal,
			settled: false,
		}
		const promise = new Promise<HandoffResult>((resolve) => {
			waiter.resolve = resolve
		})
		handoffWaiters.set(handle, waiter)

		// Abort races the clock: the bash tool kills the process on abort,
		// matching upstream behavior for the pre-handoff window.
		if (signal) {
			if (signal.aborted) {
				settleHandoffWaiter(handle, waiter, "aborted")
				return promise
			}
			waiter.onAbort = () => settleHandoffWaiter(handle, waiter, "aborted")
			signal.addEventListener("abort", waiter.onAbort, { once: true })
		}

		// Process exit always wins over the handoff clock (dispatched by the
		// handle's permanent exit observer via notifyExit).
		waiter.timer = setTimeout(() => settleHandoffWaiter(handle, waiter, "handoff"), handoffSeconds * 1000)
		waiter.timer.unref?.()

		// User-facing sessions: a queued user message hands off early so the
		// agent can answer it, but only after the minimum runtime — quick
		// commands still return a normal result. Same accepted-queue check
		// and cadence as a cohort wait (see awaitCohortEvent). clearTimeout
		// also clears an interval, so one field covers both phases.
		if (hasPendingUserInput) {
			waiter.inputTimer = setTimeout(() => {
				if (waiter.settled) return
				if (hasPendingUserInput()) {
					settleHandoffWaiter(handle, waiter, "handoff")
					return
				}
				waiter.inputTimer = setInterval(() => {
					if (hasPendingUserInput()) settleHandoffWaiter(handle, waiter, "handoff")
				}, USER_INPUT_POLL_MS)
				waiter.inputTimer.unref?.()
			}, minHandoffSeconds * 1000)
			waiter.inputTimer.unref?.()
		}

		return promise
	}

	function beginCohortWait(toolCallId: string): { ok: true } | { ok: false; error: string } {
		if (activeWait) {
			return {
				ok: false,
				error: `Another bash_control(wait: true) call is already active (${activeWait.toolCallId}). Only one concurrent cohort wait is permitted.`,
			}
		}
		activeWait = { toolCallId, resolve: () => {}, cleanup: undefined }
		return { ok: true }
	}

	function awaitCohortEvent(
		toolCallId: string,
		signal?: AbortSignal,
		waitSeconds?: number,
		delivery?: TerminalDelivery,
		hasPendingUserInput?: () => boolean,
	): Promise<CohortWaitEvent> {
		if (!activeWait || activeWait.toolCallId !== toolCallId) {
			return Promise.resolve({ kind: "aborted" })
		}
		const wait = activeWait
		// The caller validated the duration (finite, positive, capped at
		// MAX_WAIT_SECONDS by the tool); schedule it directly so fractional
		// durations keep their exact timing — no flooring, no one-second
		// minimum. Only an omitted duration falls back to the default.
		const effectiveSeconds = waitSeconds ?? defaultWaitSeconds
		let resolvePromise: (event: CohortWaitEvent) => void = () => {}
		const promise = new Promise<CohortWaitEvent>((resolve) => {
			resolvePromise = resolve
		})

		const cleanups: Array<() => void> = []
		let settled = false
		const settle = (event: CohortWaitEvent) => {
			if (settled) return
			settled = true
			// Reentrancy guard: mark wait consumed before resolving so the
			// resolved promise's continuations see no active wait.
			if (activeWait === wait) activeWait = undefined
			wait.settle = undefined
			for (const cleanup of cleanups) cleanup()
			resolvePromise(event)
		}
		wait.cleanup = () => {
			settled = true
			wait.settle = undefined
			for (const cleanup of cleanups) cleanup()
		}
		wait.resolve = (event: CohortWaitEvent) => settle(event)
		wait.settle = (event: CohortWaitEvent) => settle(event)

		// Wire abort.
		if (signal) {
			if (signal.aborted) {
				settle({ kind: "aborted" })
				return promise
			}
			const onAbort = () => settle({ kind: "aborted" })
			signal.addEventListener("abort", onAbort, { once: true })
			cleanups.push(() => signal.removeEventListener("abort", onAbort))
		}

		// Subscribe before checking: a queued result must yield a turn
		// boundary for its automatic message, even with live survivors.
		if (delivery) {
			cleanups.push(delivery.onQueuedAutomatic(() => settle({ kind: "pending-delivery" })))
			if (delivery.hasQueuedAutomatic()) {
				settle({ kind: "pending-delivery" })
				return promise
			}
		}

		// User-facing waits yield to queued user input. The check reads
		// ACCEPTED queue state (never the earlier `input` interception hook,
		// where another handler can still consume, transform, or reject the
		// submission): check immediately — a message queued before the wait
		// began releases it at once — and then at a short interval, so a
		// message queued mid-wait releases it promptly. Settling here never
		// touches processes: only the wait resolves, and the settlement
		// cleanups clear the checkpoint timer, this interval, and every
		// listener. Unattended waits pass no check and are unaffected.
		if (hasPendingUserInput) {
			if (hasPendingUserInput()) {
				settle({ kind: "user-input" })
				return promise
			}
			const inputTimer = setInterval(() => {
				if (hasPendingUserInput()) settle({ kind: "user-input" })
			}, USER_INPUT_POLL_MS)
			inputTimer.unref?.()
			cleanups.push(() => clearInterval(inputTimer))
		}

		// A handle that already reached a terminal state before the wait
		// began (its exit observer fired with no active wait) resolves the
		// wait immediately instead of waiting for the checkpoint.
		for (const handle of handles) {
			const entry = registry.getEntry(handle)
			if (entry && entry.state !== "running") {
				settle({ kind: "exit", handle })
				return promise
			}
		}

		// The bounded checkpoint timer starts when the actual wait begins
		// (the caller applied requested stops before claiming the slot).
		// Joining handles never restart or postpone it.
		const checkpointTimer = setTimeout(() => settle({ kind: "checkpoint" }), effectiveSeconds * 1000)
		checkpointTimer.unref?.()
		cleanups.push(() => clearTimeout(checkpointTimer))

		// Exits of current handles AND joiners resolve through the handles'
		// permanent exit observers (notifyExit → wait.settle).

		return promise
	}

	function endCohortWait(toolCallId: string): void {
		const wait = activeWait
		if (wait?.toolCallId !== toolCallId) return
		activeWait = undefined
		// Mark the wait settled so late exit/abort callbacks cannot resolve
		// the orphaned promise, and run its cleanups (checkpoint timer,
		// abort listener).
		wait?.cleanup?.()
	}

	return {
		handleSpawned,
		handleRemoved,
		awaitInitialHandoff,
		beginCohortWait,
		awaitCohortEvent,
		endCohortWait,
		hasActiveWait() {
			return activeWait !== undefined
		},
		get size() {
			return handles.size
		},
		handles() {
			return [...handles]
		},
		getCheckpointStreak(handle: string): number {
			return checkpointStreaks.get(handle) ?? 0
		},
		commitWaitTimeout(reportedRunning: readonly string[]): void {
			for (const handle of reportedRunning) {
				if (!handles.has(handle)) continue
				checkpointStreaks.set(handle, (checkpointStreaks.get(handle) ?? 0) + 1)
			}
		},
		commitObservation(reportedRunning: readonly string[]): void {
			for (const handle of reportedRunning) {
				checkpointStreaks.delete(handle)
			}
		},
		dispose() {
			for (const [handle, waiter] of [...handoffWaiters]) {
				settleHandoffWaiter(handle, waiter, "exited")
			}
			if (activeWait) {
				const wait = activeWait
				activeWait = undefined
				// Resolve through the wait's guarded settle entry point: it runs
				// the cleanups itself. (Calling cleanup first would mark the
				// wait settled and orphan the promise instead of resolving it.)
				wait.resolve({ kind: "aborted" })
			}
			handles.clear()
			checkpointStreaks.clear()
		},
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
