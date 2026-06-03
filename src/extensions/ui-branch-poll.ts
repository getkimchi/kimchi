export const BRANCH_POLL_INTERVAL_MS = 5000

export interface BranchPoller {
	/** Start polling for branch changes; `onChange` is called whenever the
	 *  branch returned by `refreshBranch()` differs from the last known value. */
	start(onChange: () => void): void
	/** Stop polling and reset internal state. */
	stop(): void
	/** Return the last known branch (synchronous cache read). */
	getBranch(): string | undefined
}

export function createBranchPoller(
	deps: { refreshBranch(onResult: (branch: string | undefined) => void): void },
	intervalMs: number = BRANCH_POLL_INTERVAL_MS,
): BranchPoller {
	let timer: ReturnType<typeof setInterval> | undefined
	let lastKnownBranch: string | undefined
	let onChangeCallback: (() => void) | undefined
	let refreshing = false

	function getBranch(): string | undefined {
		return lastKnownBranch
	}

	function tick(silent = false): void {
		refreshing = true
		deps.refreshBranch((currentBranch) => {
			refreshing = false
			if (currentBranch !== lastKnownBranch) {
				lastKnownBranch = currentBranch
				if (!silent) onChangeCallback?.()
			}
		})
	}

	function start(onChange: () => void) {
		stop()
		onChangeCallback = onChange
		tick(true)
		timer = setInterval(() => {
			if (!refreshing) tick()
		}, intervalMs)
	}

	function stop() {
		if (timer) {
			clearInterval(timer)
			timer = undefined
		}
		lastKnownBranch = undefined
		onChangeCallback = undefined
		refreshing = false
	}

	return { start, stop, getBranch }
}
