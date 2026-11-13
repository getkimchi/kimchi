/**
 * Map with bounded concurrency, preserving input order in the results.
 * Worker pulls the next index — no per-item task pre-allocation.
 * Shared by the drain pipeline (extraction windows), the decision-gate
 * batching (parallel d3 chunk calls), and the supersede candidate search
 * (parallel embedding queries).
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length)
	let next = 0
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		while (next < items.length) {
			const index = next
			next += 1
			results[index] = await fn(items[index] as T, index)
		}
	})
	await Promise.all(workers)
	return results
}
