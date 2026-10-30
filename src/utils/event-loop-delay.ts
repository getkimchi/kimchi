/**
 * Event-loop delay monitor: a heartbeat interval whose late firings measure
 * how long the event loop was blocked between ticks.
 *
 * Used by tests and the export verification script to prove that offloaded
 * work no longer freezes the harness: a synchronous multi-second pipeline
 * shows up as one gap of that size, while an offloaded one keeps the loop
 * within scheduling jitter.
 */

export interface EventLoopDelayMonitor {
	/**
	 * Stop monitoring and return the largest observed gap between two
	 * consecutive timer firings, in milliseconds. Includes the interval
	 * itself (a 10ms interval reports ~10ms when idle).
	 */
	stop(): number
}

/**
 * Start a heartbeat timer at `intervalMs`. The monitor never keeps the
 * process alive on its own (the timer is unref'd).
 */
export function startEventLoopDelayMonitor(intervalMs = 10): EventLoopDelayMonitor {
	let maxGapMs = 0
	let lastTick = Date.now()
	const timer = setInterval(() => {
		const now = Date.now()
		const gap = now - lastTick
		lastTick = now
		if (gap > maxGapMs) maxGapMs = gap
	}, intervalMs)
	// Monitoring must never extend the process lifetime.
	if (typeof timer.unref === "function") {
		timer.unref()
	}
	return {
		stop(): number {
			clearInterval(timer)
			return maxGapMs
		},
	}
}
