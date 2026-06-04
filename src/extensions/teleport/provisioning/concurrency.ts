/**
 * Counting semaphore for bounding parallel async operations. Used by the
 * estimate-bytes walkers to cap in-flight `readdir`/`stat` calls so a wide
 * monorepo can't exhaust the OS file-descriptor limit (EMFILE) or swamp the
 * libuv thread pool. Waiters are served FIFO; releasing hands the slot
 * directly to the next waiter without going through the `available` counter,
 * so there's no thundering-herd wake-up.
 */
export class Semaphore {
	private available: number
	private readonly waiters: Array<() => void> = []

	constructor(limit: number) {
		if (limit < 1) throw new Error(`Semaphore limit must be >= 1, got ${limit}`)
		this.available = limit
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire()
		try {
			return await fn()
		} finally {
			this.release()
		}
	}

	private acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--
			return Promise.resolve()
		}
		return new Promise((resolve) => this.waiters.push(resolve))
	}

	private release(): void {
		const next = this.waiters.shift()
		if (next) next()
		else this.available++
	}
}
