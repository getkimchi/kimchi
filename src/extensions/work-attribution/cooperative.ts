import { setImmediate } from "node:timers/promises"

/** Apply the original mapping function in order, with checkpoints between bounded batches. */
export function* mapInChunks<T, U>(rows: readonly T[], batchSize: number, map: (row: T) => U): Generator<void, U[]> {
	if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new RangeError("batch size must be positive")
	const result: U[] = []
	for (let index = 0; index < rows.length; index += batchSize) {
		yield
		result.push(...rows.slice(index, index + batchSize).map(map))
	}
	return result
}

/** Drain the same calculation used by capture without yielding the synchronous /work read path. */
export function runSynchronously<T>(steps: Generator<void, T>): T {
	for (;;) {
		const result = steps.next()
		if (result.done) return result.value
	}
}

/** Keep a long calculation responsive while retaining its local state and result ordering. */
export async function runCooperatively<T>(steps: Generator<void, T>, check: () => void, sliceMs = 10): Promise<T> {
	let sliceStarted = performance.now()
	for (;;) {
		check()
		const result = steps.next()
		if (result.done) return result.value
		if (performance.now() - sliceStarted >= sliceMs) {
			await setImmediate()
			sliceStarted = performance.now()
		}
	}
}
