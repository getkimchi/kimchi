/**
 * Cancellable pending-notification scheduler for subagent nudges.
 *
 * Each nudge is a delayed callback that fires after a short hold period
 * (200 ms by default) to coalesce rapid-fire agent completions. The
 * scheduler tracks a `shuttingDown` flag that, once set, prevents new
 * nudges from being scheduled and clears any pending ones.
 *
 * This prevents a race condition where background agents completing
 * during `session_shutdown` → `waitForSubagentShutdown` would schedule
 * new nudge timers after the existing ones were cleared. Those timers
 * would fire with an already-stale extension ctx, crashing the process
 * with "This extension ctx is stale after session replacement or reload."
 */
export class NudgeScheduler {
	private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()
	private _shuttingDown = false
	private readonly holdMs: number

	constructor(holdMs = 200) {
		this.holdMs = holdMs
	}

	get isShuttingDown(): boolean {
		return this._shuttingDown
	}

	get pendingCount(): number {
		return this.pending.size
	}

	hasPending(key: string): boolean {
		return this.pending.has(key)
	}

	/**
	 * Schedule a nudge callback. If `beginShutdown()` has been called,
	 * this is a no-op — the pi ctx will be stale by the time the timer fires.
	 */
	schedule(key: string, send: () => void, delay?: number): void {
		if (this._shuttingDown) return
		this.cancel(key)
		this.pending.set(
			key,
			setTimeout(() => {
				this.pending.delete(key)
				send()
			}, delay ?? this.holdMs),
		)
	}

	cancel(key: string): void {
		const timer = this.pending.get(key)
		if (timer != null) {
			clearTimeout(timer)
			this.pending.delete(key)
		}
	}

	/**
	 * Mark the scheduler as shutting down. Clears all pending timers
	 * and prevents future `schedule()` calls from creating new ones.
	 */
	beginShutdown(): void {
		this._shuttingDown = true
		for (const timer of this.pending.values()) clearTimeout(timer)
		this.pending.clear()
	}
}
