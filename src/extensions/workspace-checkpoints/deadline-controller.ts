const MAX_TIMER_MS = 2_147_483_647

export function finalizationDelayMs(durationSeconds: number): number {
	const reserveMs = Math.min(durationSeconds * 100, 300_000)
	return Math.max(0, durationSeconds * 1000 - reserveMs)
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

/** One-shot finalization and hard-deadline timers anchored to one session's start. */
export class DeadlineController {
	private finalizationTimer: ReturnType<typeof setTimeout> | undefined
	private hardTimer: ReturnType<typeof setTimeout> | undefined
	private disposed = false

	constructor(
		private readonly durationSeconds: number,
		private readonly actions: DeadlineActions,
		private readonly startedAtMs = Date.now(),
	) {}

	private scheduleTimer(
		field: "finalizationTimer" | "hardTimer",
		targetMs: number,
		action: () => void,
		description: string,
	): void {
		const tick = () => {
			if (this.disposed) return
			const remaining = targetMs - Date.now()
			if (remaining > 0) {
				this[field] = setTimeout(tick, Math.min(remaining, MAX_TIMER_MS))
				return
			}
			try {
				action()
			} catch (error) {
				console.error(`workspace-checkpoints: ${description} failed:`, error)
			}
		}
		this[field] = setTimeout(tick, Math.max(0, Math.min(MAX_TIMER_MS, targetMs - Date.now())))
	}

	start(): void {
		if (this.finalizationTimer || this.hardTimer) return
		this.disposed = false
		this.scheduleTimer(
			"finalizationTimer",
			this.startedAtMs + finalizationDelayMs(this.durationSeconds),
			this.actions.finalize,
			"finalization request",
		)
		this.scheduleTimer("hardTimer", this.startedAtMs + this.durationSeconds * 1000, this.actions.abort, "hard deadline")
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
