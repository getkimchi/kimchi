export const BRANCH_POLL_INTERVAL_MS = 5000

export interface BranchPoller {
	/** Start polling for branch changes; `onChange` is called whenever the
	 *  branch returned by `getGitBranch()` differs from the last known value. */
	start(onChange: () => void): void
	/** Stop polling and reset internal state. */
	stop(): void
}

export function createBranchPoller(
	deps: { getGitBranch(): string | undefined },
	intervalMs: number = BRANCH_POLL_INTERVAL_MS,
): BranchPoller {
	let timer: ReturnType<typeof setInterval> | undefined
	let lastKnownBranch: string | undefined

	function start(onChange: () => void) {
		stop()
		lastKnownBranch = deps.getGitBranch()
		timer = setInterval(() => {
			const currentBranch = deps.getGitBranch()
			if (currentBranch !== lastKnownBranch) {
				lastKnownBranch = currentBranch
				onChange()
			}
		}, intervalMs)
	}

	function stop() {
		if (timer) {
			clearInterval(timer)
			timer = undefined
		}
		lastKnownBranch = undefined
	}

	return { start, stop }
}
