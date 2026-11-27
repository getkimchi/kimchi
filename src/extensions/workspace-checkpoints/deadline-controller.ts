const MAX_TIMER_MS = 2_147_483_647

export function finalizationDelayMs(durationSeconds: number): number {
	const reserveMs = Math.min(durationSeconds * 100, 300_000)
	return Math.min(MAX_TIMER_MS, Math.max(0, durationSeconds * 1000 - reserveMs))
}

export function parseMaxSessionDuration(value: string | undefined): number | undefined {
	if (value === undefined) return undefined
	if (!/^\d+$/.test(value.trim()) || Number.parseInt(value, 10) <= 0) {
		throw new Error(`Invalid --max-session-duration value "${value}": expected a positive integer number of seconds.`)
	}
	return Number.parseInt(value, 10)
}

interface DeadlineActions {
	finalize: () => void
	abort: () => void
}

/** One-shot finalization and hard-deadline timers for a single session. */
export class DeadlineController {
	private finalizationTimer: ReturnType<typeof setTimeout> | undefined
	private hardTimer: ReturnType<typeof setTimeout> | undefined
	private disposed = false

	constructor(
		private readonly durationSeconds: number,
		private readonly actions: DeadlineActions,
	) {}

	start(): void {
		if (this.disposed || this.finalizationTimer || this.hardTimer) return
		this.finalizationTimer = setTimeout(() => {
			if (this.disposed) return
			try {
				this.actions.finalize()
			} catch (error) {
				console.error("workspace-checkpoints: finalization request failed:", error)
			}
		}, finalizationDelayMs(this.durationSeconds))
		this.hardTimer = setTimeout(
			() => {
				if (this.disposed) return
				try {
					this.actions.abort()
				} catch (error) {
					console.error("workspace-checkpoints: hard deadline failed:", error)
				}
			},
			Math.min(MAX_TIMER_MS, this.durationSeconds * 1000),
		)
	}

	/** Dispose on settlement, shutdown, cancellation, or session replacement. */
	dispose(): void {
		this.disposed = true
		if (this.finalizationTimer) clearTimeout(this.finalizationTimer)
		if (this.hardTimer) clearTimeout(this.hardTimer)
		this.finalizationTimer = undefined
		this.hardTimer = undefined
	}
}
