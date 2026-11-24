/**
 * A worker wall-clock deadline that can be suspended during interactive waits.
 * Holds and releases compose: the clock resumes only when the final hold ends.
 */
/** Mutable per-session reference: a resume installs its own clock here. */
export interface InteractiveTimeBudgetRef {
	budget: InteractiveTimeBudget
}

export interface InteractiveTimeBudget {
	/** Suspend the deadline. Returns an idempotent release callback. */
	pause(): () => void
	/** Arm the expiry callback against the unpaused time that remains. */
	setOnExpire(callback: () => void): void
	/** Remaining running time, in milliseconds, excluding the current pause. Infinity for an unlimited budget. */
	getRemainingMs(): number
	/** Cancel any expiry timer and stop tracking further holds. */
	dispose(): void
}

export function createInteractiveTimeBudget(
	maxDurationSeconds: number,
	startTimeMs: number,
	clock: () => number = Date.now,
): InteractiveTimeBudget {
	let deadlineMs = startTimeMs + maxDurationSeconds * 1000
	let holdCount = 0
	let pauseStartedAt: number | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	let onExpire: (() => void) | undefined
	let disposed = false

	function clearTimer(): void {
		if (timer) clearTimeout(timer)
		timer = undefined
	}

	function schedule(): void {
		clearTimer()
		const callback = onExpire
		if (disposed || !callback || maxDurationSeconds <= 0 || pauseStartedAt !== undefined) return
		const remainingMs = Math.max(0, deadlineMs - clock())
		timer = setTimeout(() => {
			timer = undefined
			// A wait can begin after a timer becomes eligible but before its
			// callback runs. That wait still owns the worker's deadline.
			if (disposed || pauseStartedAt !== undefined) return
			callback()
		}, remainingMs)
	}

	return {
		pause() {
			if (disposed) return () => {}
			if (holdCount === 0) {
				pauseStartedAt = clock()
				clearTimer()
			}
			holdCount += 1
			let released = false
			return () => {
				if (released || disposed) return
				released = true
				holdCount -= 1
				if (holdCount > 0 || pauseStartedAt === undefined) return
				deadlineMs += clock() - pauseStartedAt
				pauseStartedAt = undefined
				schedule()
			}
		},
		setOnExpire(callback) {
			onExpire = callback
			schedule()
		},
		getRemainingMs() {
			// A zero duration means no limit, not an exhausted one: a resume
			// can run unlimited on a session whose first run had a limit, and
			// its bash calls must not be clamped as if no time were left.
			if (maxDurationSeconds <= 0) return Number.POSITIVE_INFINITY
			// Freeze the remaining budget while waiting on the user, both for
			// the expiry callback and for bash's remaining-time clamp.
			return Math.max(0, deadlineMs - (pauseStartedAt ?? clock()))
		},
		dispose() {
			disposed = true
			clearTimer()
			onExpire = undefined
		},
	}
}
