import { raceWithTimeout } from "../../shared/race-with-timeout.js"

interface LiveReviewChild {
	lease: symbol
	promise: Promise<unknown>
	cancel: () => void
}

const liveByOutputDir = new Map<string, Map<symbol, LiveReviewChild>>()

function children(outputDir: string): Map<symbol, LiveReviewChild> {
	let entries = liveByOutputDir.get(outputDir)
	if (!entries) {
		entries = new Map()
		liveByOutputDir.set(outputDir, entries)
	}
	return entries
}

/** Track actual agent spawns only; abandoned promise settlements never remove a
 * newer invocation with the same writer ID. */
export function trackLiveReviewChild<T>(
	outputDir: string,
	id: string,
	run: Promise<T>,
	cancel: () => void,
): Promise<T> {
	const lease = Symbol(id)
	const entry: LiveReviewChild = {
		lease,
		promise: run,
		cancel,
	}
	children(outputDir).set(lease, entry)
	const remove = () => {
		const entries = liveByOutputDir.get(outputDir)
		if (entries?.get(lease) === entry) {
			entries.delete(lease)
			if (entries.size === 0) liveByOutputDir.delete(outputDir)
		}
	}
	void run.then(remove, remove)
	return run
}

/** Best-effort process-local cancellation followed by one bounded settlement
 * wait. Deadline expiry never deletes live entries; a publication-boundary
 * rescan remains responsible for their source-file submissions. */
export async function cancelAndWaitForReviewChildren(outputDir: string, timeoutMs: number): Promise<void> {
	const entries = [...(liveByOutputDir.get(outputDir)?.values() ?? [])]
	if (entries.length === 0) return
	for (const entry of entries) {
		try {
			entry.cancel()
		} catch {
			// A runner that already closed has nothing further to cancel.
		}
	}
	const settled = Promise.allSettled(entries.map((entry) => entry.promise))
	await raceWithTimeout(settled, Math.max(0, timeoutMs), undefined)
}
