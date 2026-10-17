import { type StatsListener, unwatchFile, watchFile } from "node:fs"

/**
 * Stat-polls a single file with no directory subscription (no FSEvents /
 * inotify involvement, so no recursive watcher fan-out under the agent dir).
 *
 * All filesystem watchers in extensions must use this instead of hand-rolled
 * `watchFile` + boolean-flag pairs, so the arm / stop lifecycle has one shape:
 * `stop()` is idempotent, and `isActive()` is the "still armed" gate that
 * re-scheduling code checks before queueing more work.
 */
export interface StatPoller {
	/** False once `stop()` has run — use as the gate for re-scheduling work. */
	isActive(): boolean
	/** Unwatches the listener on first call; later calls are a no-op. */
	stop(): void
}

export function startStatPoller(path: string, intervalMs: number, listener: StatsListener): StatPoller {
	watchFile(path, { persistent: false, interval: intervalMs }, listener)
	let active = true
	return {
		isActive: () => active,
		stop() {
			if (active) unwatchFile(path, listener)
			active = false
		},
	}
}
