/**
 * Checkin race primitive shared by the background `bash` tool and the
 * `bash_control` companion tool.
 *
 * `awaitCheckin` resolves when EITHER the checkin interval elapses OR the
 * process exits — whichever comes first.
 */
import type { ProcessRegistry, TailSnapshot } from "./process-registry.js"

export async function awaitCheckin(
	registry: ProcessRegistry,
	handle: string,
	intervalSeconds: number,
): Promise<TailSnapshot> {
	// Fast path: check if entry already shows exited.
	const entry = registry.getEntry(handle)
	if (entry && entry.state !== "running") {
		return registry.snapshotTail(handle)
	}

	// Race the checkin timer against process exit.
	let timer: NodeJS.Timeout | undefined
	const timerPromise = new Promise<"timer">((resolve) => {
		timer = setTimeout(() => resolve("timer"), Math.max(0, intervalSeconds) * 1000)
	})
	const exitPromise = registry
		.whenExited(handle)
		.then(() => "exit" as const)
		.catch(() => "exit" as const)

	try {
		await Promise.race([timerPromise, exitPromise])
	} finally {
		if (timer) clearTimeout(timer)
	}

	return registry.snapshotTail(handle)
}
