/**
 * Session review coordinator for background bash.
 *
 * Owns the ONE scheduling clock for the whole background-bash cohort of a
 * session, so the number of running processes never multiplies the number
 * of model review turns. Two distinct timer concepts live here:
 *
 *  - Initial handoff (≤ `handoffSeconds`, default 15s): a one-time,
 *    per-command deadline for the `bash` tool call that spawned the
 *    process. When the process is still running at the deadline, `bash`
 *    resolves with the handle and unseen output. Commands spawned while
 *    the cohort's first handoff is still pending share that deadline; a
 *    later joiner gets its own bounded handoff but NEVER creates or
 *    resets a recurring review timer.
 *  - Cohort review (every `reviewIntervalSeconds`, default 60s): one
 *    recurring clock for all tracked handles. The first handoff of a
 *    fresh cohort counts as review #1; the recurring schedule starts 60s
 *    after it. Joins, exits, and `bash_control` calls never postpone a
 *    scheduled review. At most one review can be pending at a time.
 *
 * A due review is delivered through, in priority order:
 *   1. an active `bash_control(wait: true)` call (resolves it), or
 *   2. the extension's `onReviewDue` callback, which piggybacks on the
 *      current turn or wakes an idle agent via `pi.sendMessage`.
 *
 * This module is intentionally free of any `ExtensionAPI` dependency:
 * message delivery is delegated to the injected `onReviewDue` callback so
 * the coordinator stays unit-testable with fake timers.
 */
import type { ProcessRegistry } from "./process-registry.js"

/** One-time per-command handoff deadline (seconds). */
export const INITIAL_HANDOFF_SECONDS = 15

/** Recurring cohort review interval (seconds). Harness-owned, never model-set. */
export const COHORT_REVIEW_INTERVAL_SECONDS = 60

export type HandoffResult = "exited" | "handoff" | "aborted"

export type CohortWaitEvent = { kind: "exit"; handle: string } | { kind: "review" } | { kind: "aborted" }

export interface ReviewCoordinatorOptions {
	registry: ProcessRegistry
	/** Called when a recurring review is due and no active cohort wait claimed it. */
	onReviewDue?: () => void
	/** Test override for the initial handoff deadline (seconds). */
	handoffSeconds?: number
	/** Test override for the recurring review interval (seconds). */
	reviewIntervalSeconds?: number
}

export interface ReviewCoordinator {
	/** Join `handle` to the cohort. Starts the clock when the cohort was empty. */
	handleSpawned(handle: string): void
	/** Remove `handle` from the cohort. Resets the clock when the cohort empties. */
	handleRemoved(handle: string): void
	/**
	 * Resolve when the freshly spawned `handle` reaches its one-time
	 * handoff deadline ("handoff"), its process exits ("exited"), or the
	 * provided signal aborts ("aborted").
	 */
	awaitInitialHandoff(handle: string, signal?: AbortSignal): Promise<HandoffResult>
	/**
	 * Claim the single concurrent cohort-wait slot. Returns `{ ok: false }`
	 * when another `bash_control(wait: true)` is already active.
	 */
	beginCohortWait(toolCallId: string): { ok: true } | { ok: false; error: string }
	/**
	 * Block until the first cohort exit, the next due review, or abort.
	 * Must be paired with `beginCohortWait`/`endCohortWait`.
	 */
	awaitCohortEvent(toolCallId: string, signal?: AbortSignal): Promise<CohortWaitEvent>
	/** Release the cohort-wait slot without awaiting further events. */
	endCohortWait(toolCallId: string): void
	/** Whether a `bash_control(wait: true)` currently owns the wait slot. */
	hasActiveWait(): boolean
	/** Absolute time (ms) of the next recurring review, if scheduled. */
	readonly nextReviewAtMs: number | undefined
	/** Whether a due review is awaiting delivery. */
	hasPendingReview(): boolean
	/** Mark the pending review delivered (enqueue-to-model counts as delivery). */
	reviewDelivered(): void
	/** Number of handles currently in the cohort. */
	readonly size: number
	/** Snapshot of the handle ids currently in the cohort. */
	handles(): string[]
	/** Cancel every timer and listener without resolving waiters. */
	dispose(): void
}

export function createReviewCoordinator(options: ReviewCoordinatorOptions): ReviewCoordinator {
	const registry = options.registry
	const handoffSeconds = options.handoffSeconds ?? INITIAL_HANDOFF_SECONDS
	const reviewIntervalSeconds = options.reviewIntervalSeconds ?? COHORT_REVIEW_INTERVAL_SECONDS

	const handles = new Set<string>()
	// Shared first-handoff clock. While it is pending, every joiner shares
	// it; when it fires, it counts as review #1 and arms the recurring clock.
	let firstHandoffTimer: NodeJS.Timeout | undefined
	// Recurring cohort review clock (undefined until the first handoff fires).
	let reviewTimer: NodeJS.Timeout | undefined
	let nextReviewAt: number | undefined
	let pendingReview = false

	interface HandoffWaiter {
		resolve: (result: HandoffResult) => void
		timer: NodeJS.Timeout | undefined
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
		 * Installed by `awaitCohortEvent`: the guarded entry point handle
		 * exits resolve through. Undefined for a never-awaited slot and
		 * cleared when the wait settles or is released, so late exit
		 * callbacks of orphaned waits become no-ops.
		 */
		settle?: (event: CohortWaitEvent) => void
		/** Handles whose exit is already wired to this wait. */
		wiredHandles?: Set<string>
	}
	let activeWait: ActiveWait | undefined

	function clearFirstHandoffTimer(): void {
		if (firstHandoffTimer) {
			clearTimeout(firstHandoffTimer)
			firstHandoffTimer = undefined
		}
	}

	function clearReviewTimer(): void {
		if (reviewTimer) {
			clearTimeout(reviewTimer)
			reviewTimer = undefined
		}
		nextReviewAt = undefined
	}

	function armRecurringReview(): void {
		clearReviewTimer()
		nextReviewAt = Date.now() + reviewIntervalSeconds * 1000
		reviewTimer = setTimeout(fireReview, reviewIntervalSeconds * 1000)
		reviewTimer.unref?.()
	}

	function fireReview(): void {
		reviewTimer = undefined
		if (handles.size === 0) {
			nextReviewAt = undefined
			return
		}
		// Keep the cadence anchored to fire time: joins/exits/waits never
		// postpone the next scheduled review.
		armRecurringReview()
		// At most one outstanding review: a tick while the previous review
		// is still pending must not enqueue another one.
		if (pendingReview) return
		pendingReview = true
		if (activeWait) {
			// An active bash_control(wait:true) claims the review — resolving
			// the wait IS the delivery, so the pending flag clears here.
			pendingReview = false
			resolveActiveWait({ kind: "review" })
			return
		}
		options.onReviewDue?.()
	}

	function resolveActiveWait(event: CohortWaitEvent): void {
		const wait = activeWait
		if (!wait) return
		activeWait = undefined
		// wait.resolve is `settle` once awaitCohortEvent installed it; settle
		// runs the cleanup callbacks itself. Only the never-awaited noop
		// resolve path needs the explicit cleanup below.
		wait.resolve(event)
	}

	function settleHandoffWaiter(handle: string, waiter: HandoffWaiter, result: HandoffResult): void {
		if (waiter.settled) return
		waiter.settled = true
		if (waiter.timer) clearTimeout(waiter.timer)
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort)
		handoffWaiters.delete(handle)
		waiter.resolve(result)
	}

	function fireSharedFirstHandoff(): void {
		firstHandoffTimer = undefined
		if (handles.size === 0) return
		// The first handoff counts as the cohort's first review; the
		// recurring clock starts `reviewIntervalSeconds` after it.
		armRecurringReview()
		for (const [handle, waiter] of [...handoffWaiters]) {
			settleHandoffWaiter(handle, waiter, "handoff")
		}
	}

	/**
	 * Wire one handle's exit to a live cohort wait. Idempotent per wait:
	 * each handle resolves the current wait at most once, and a settled or
	 * released wait ignores late firings via its settle guard.
	 */
	function wireExitToWait(handle: string, wait: ActiveWait): void {
		wait.wiredHandles ??= new Set()
		if (wait.wiredHandles.has(handle)) return
		wait.wiredHandles.add(handle)
		void registry
			.whenExited(handle)
			.then(() => wait.settle?.({ kind: "exit", handle }))
			.catch(() => wait.settle?.({ kind: "exit", handle }))
	}

	function handleSpawned(handle: string): void {
		const cohortWasEmpty = handles.size === 0
		handles.add(handle)
		// A handle spawned while a cohort wait is blocking joins that wait:
		// its exit resolves the in-flight wait like any tracked exit.
		if (activeWait?.settle) wireExitToWait(handle, activeWait)
		if (!cohortWasEmpty) return
		// Fresh cohort: the first command's handoff IS review #1. Arm the
		// shared clock; do not arm a second review timer.
		clearReviewTimer()
		pendingReview = false
		firstHandoffTimer = setTimeout(fireSharedFirstHandoff, handoffSeconds * 1000)
		firstHandoffTimer.unref?.()
	}

	function handleRemoved(handle: string): void {
		handles.delete(handle)
		const waiter = handoffWaiters.get(handle)
		if (waiter) settleHandoffWaiter(handle, waiter, "exited")
		if (handles.size > 0) return
		// Empty cohort: cancel the clock and reset the cycle so the next
		// long-running process starts a fresh handoff/review cycle.
		clearFirstHandoffTimer()
		clearReviewTimer()
		pendingReview = false
	}

	function awaitInitialHandoff(handle: string, signal?: AbortSignal): Promise<HandoffResult> {
		const entry = registry.getEntry(handle)
		if (!entry || entry.state !== "running") return Promise.resolve("exited")

		const waiter: HandoffWaiter = {
			resolve: () => {},
			timer: undefined,
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

		// Process exit always wins over the handoff clock.
		void registry
			.whenExited(handle)
			.then(() => settleHandoffWaiter(handle, waiter, "exited"))
			.catch(() => settleHandoffWaiter(handle, waiter, "exited"))

		// While the cohort's first handoff clock is pending, this command
		// shares it (fireSharedFirstHandoff settles this waiter). A later
		// joiner during the recurring-review phase gets its own bounded
		// one-time handoff timer.
		if (!firstHandoffTimer) {
			waiter.timer = setTimeout(() => settleHandoffWaiter(handle, waiter, "handoff"), handoffSeconds * 1000)
			waiter.timer.unref?.()
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

	function awaitCohortEvent(toolCallId: string, signal?: AbortSignal): Promise<CohortWaitEvent> {
		if (!activeWait || activeWait.toolCallId !== toolCallId) {
			return Promise.resolve({ kind: "aborted" })
		}
		const wait = activeWait
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
		// Coordinator-level resolution paths (fireReview, dispose) and handle
		// exits both end at the same settled guard.
		wait.resolve = (event: CohortWaitEvent) => settle(event)
		wait.settle = (event: CohortWaitEvent) => settle(event)

		// Wire abort.
		let onAbort: (() => void) | undefined
		if (signal) {
			if (signal.aborted) {
				settle({ kind: "aborted" })
				return promise
			}
			onAbort = () => settle({ kind: "aborted" })
			signal.addEventListener("abort", onAbort, { once: true })
			cleanups.push(() => signal.removeEventListener("abort", onAbort as () => void))
		}

		// Wire every currently tracked handle's exit; handles spawned DURING
		// the wait are wired by handleSpawned, so a joiner's exit resolves
		// this wait too (ownership is coordinated by the bash-control
		// extension's claim table).
		for (const handle of handles) {
			wireExitToWait(handle, wait)
		}

		// If a review fires while this wait is active, fireReview resolves it
		// via resolveActiveWait — which calls wait.resolve → settle.

		return promise
	}

	function endCohortWait(toolCallId: string): void {
		const wait = activeWait
		if (wait?.toolCallId !== toolCallId) return
		activeWait = undefined
		// Mark the wait settled so late exit/abort callbacks cannot resolve
		// the orphaned promise, and remove its signal listener.
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
		get nextReviewAtMs() {
			return nextReviewAt
		},
		hasPendingReview() {
			return pendingReview
		},
		reviewDelivered() {
			pendingReview = false
		},
		get size() {
			return handles.size
		},
		handles() {
			return [...handles]
		},
		dispose() {
			clearFirstHandoffTimer()
			clearReviewTimer()
			for (const [handle, waiter] of [...handoffWaiters]) {
				settleHandoffWaiter(handle, waiter, "exited")
			}
			resolveActiveWait({ kind: "aborted" })
			handles.clear()
			pendingReview = false
		},
	}
}
