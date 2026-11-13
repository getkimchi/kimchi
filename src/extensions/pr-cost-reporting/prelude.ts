import { setImmediate } from "node:timers/promises"

/** Rows or milliseconds of prelude work a stretch may own before the UI loop gets a turn. */
const PRELUDE_YIELD_ROWS = 2_000
const PRELUDE_YIELD_MS = 50

/** Yields to the loop every `rows` pulled rows or `ms` of stretch time, whichever comes first. */
export function preludeStretch(rows = PRELUDE_YIELD_ROWS, ms = PRELUDE_YIELD_MS): () => Promise<void> {
	let pulled = 0
	let stamp = Date.now()
	return async () => {
		pulled += 1
		if (pulled < rows && Date.now() - stamp < ms) return
		pulled = 0
		stamp = Date.now()
		await setImmediate()
	}
}
