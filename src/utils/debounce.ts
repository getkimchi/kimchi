/** Trailing-edge debounce: each schedule resets the window, fn fires once after waitMs of quiet. */
export function createDebounce(fn: () => void, waitMs: number): { schedule(): void; cancel(): void } {
	let timer: NodeJS.Timeout | undefined
	return {
		schedule() {
			if (timer !== undefined) clearTimeout(timer)
			timer = setTimeout(() => {
				timer = undefined
				fn()
			}, waitMs)
		},
		cancel() {
			if (timer !== undefined) {
				clearTimeout(timer)
				timer = undefined
			}
		},
	}
}
