/**
 * Checkin race primitive shared by the background `bash` tool and the
 * `bash_control` companion tool.
 *
 * `awaitCheckin` resolves when EITHER the checkin interval elapses OR the
 * process exits — whichever comes first.
 */
import type { ProcessDisplaySnapshot, ProcessRegistry, TailSnapshot } from "./process-registry.js"

export async function awaitCheckin(
	registry: ProcessRegistry,
	handle: string,
	intervalSeconds: number,
	onUpdate?: (snapshot: ProcessDisplaySnapshot) => void,
): Promise<TailSnapshot> {
	const emitUpdate = () => {
		const snapshot = registry.displaySnapshot(handle)
		if (snapshot) onUpdate?.(snapshot)
	}
	emitUpdate()
	// Fast path: check if entry already shows exited.
	const entry = registry.getEntry(handle)
	if (entry && entry.state !== "running") {
		await registry.whenExited(handle)
		emitUpdate()
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

	const updateTimer = onUpdate ? setInterval(emitUpdate, 250) : undefined
	try {
		await Promise.race([timerPromise, exitPromise])
	} finally {
		if (timer) clearTimeout(timer)
		if (updateTimer) clearInterval(updateTimer)
	}

	// A stop request changes state before the process has flushed its final bytes.
	if (registry.getEntry(handle)?.state !== "running") await registry.whenExited(handle)
	emitUpdate()
	return registry.snapshotTail(handle)
}
