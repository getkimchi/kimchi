/**
 * Checkin race primitive shared by the background `bash` tool and the
 * `bash_control` companion tool.
 *
 * `awaitCheckin` resolves when EITHER the checkin interval elapses OR the
 * process exits — whichever comes first. This is the core of the
 * resolve-at-checkin wake model: `bash.execute()` calls it for the first
 * checkin, and `bash_control.execute()` calls it for each subsequent
 * `continue`. The caller then inspects the returned `TailSnapshot.state`
 * to know whether the process is still running (→ expect another
 * `bash_control` call) or has exited (→ final result).
 */
import type { ProcessRegistry, TailSnapshot } from "./process-registry.js"

/**
 * Wait until the next checkin: resolve after `intervalSeconds` OR when the
 * process exits, whichever is first. Returns the tail-window snapshot at
 * that point.
 *
 * If the process already exited before this call, resolves immediately with
 * the final snapshot (no timer armed).
 */
export async function awaitCheckin(
	registry: ProcessRegistry,
	handle: string,
	intervalSeconds: number,
): Promise<TailSnapshot> {
	// Fast path: already settled.
	const entry = registry.getEntry(handle)
	if (entry && entry.state !== "running") {
		return registry.snapshotTail(handle)
	}

	let timer: NodeJS.Timeout | undefined
	const timerPromise = new Promise<"timer">((resolve) => {
		timer = setTimeout(() => resolve("timer"), Math.max(0, intervalSeconds) * 1000)
	})
	const exitPromise = registry.whenExited(handle).then(() => "exit" as const)

	try {
		const winner = await Promise.race([timerPromise, exitPromise])
		if (winner === "timer" && timer) {
			// Interval won; process still running.
		}
	} finally {
		if (timer) clearTimeout(timer)
	}

	return registry.snapshotTail(handle)
}
