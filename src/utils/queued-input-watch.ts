/** Shared pending-input responsiveness target used by bash and subagent waits. */
export const USER_INPUT_POLL_MS = 50

export interface QueuedInputWatchOptions {
	/** Polling cadence; the caller owns this behavior. */
	pollIntervalMs: number
	/** Omit for an immediate synchronous probe. A number, including zero, defers it. */
	initialDelayMs?: number
	/** Preserve the caller's policy for failures reading queue state. */
	suppressProbeErrors?: boolean
}

/**
 * Poll for queued user input and return a function that stops the watch.
 * The callback runs at most once, after the poll timer has been stopped.
 * The caller owns its own settlement, timeout, and abort behavior.
 */
export function watchQueuedUserInput(
	hasPendingUserInput: () => boolean,
	onQueuedUserInput: () => void,
	options: QueuedInputWatchOptions,
): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined
	let stopped = false

	const stop = () => {
		if (stopped) return
		stopped = true
		if (timer !== undefined) clearTimeout(timer)
	}
	const inputQueued = () => {
		try {
			return hasPendingUserInput()
		} catch (error) {
			if (!options.suppressProbeErrors) throw error
			return false
		}
	}
	const probe = () => {
		if (stopped) return
		if (!inputQueued()) return
		stop()
		onQueuedUserInput()
	}
	const start = () => {
		if (stopped) return
		probe()
		if (stopped) return
		timer = setInterval(probe, options.pollIntervalMs)
		timer.unref?.()
	}

	if (options.initialDelayMs === undefined) {
		start()
	} else {
		timer = setTimeout(start, options.initialDelayMs)
		timer.unref?.()
	}

	return stop
}
