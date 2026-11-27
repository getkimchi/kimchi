// Slow-runner mode for finding timing-sensitive tests. Off unless
// KIMCHI_TEST_JITTER=1. It blocks the event loop of each test worker for
// short random periods, which is what a busy CI runner does. A test that
// relies on a short real-time limit not firing (a 25 ms request timeout,
// a 50 ms write budget) then fails here instead of at random in CI.
//
//   KIMCHI_TEST_JITTER=1 pnpm run test
//
// Optional knobs:
//   KIMCHI_TEST_JITTER_SEED      seed (default 1); repeats a single-file run, not a full suite
//   KIMCHI_TEST_JITTER_BLOCK_MS  block length range "min-max" (default "60-120")
//   KIMCHI_TEST_JITTER_GAP_MS    pause between blocks "min-max" (default "5-30")

const STARTED = Symbol.for("kimchi.test.eventLoopJitter")

function range(value: string | undefined, fallback: [number, number]): [number, number] {
	const match = value?.match(/^(\d+)-(\d+)$/)
	if (!match) return fallback
	const min = Number(match[1])
	const max = Number(match[2])
	return max >= min ? [min, max] : fallback
}

// Own PRNG (mulberry32): tests mock Math.random, and a seed makes runs repeatable.
function prng(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const globals = globalThis as typeof globalThis & { [STARTED]?: boolean }

if (process.env.KIMCHI_TEST_JITTER === "1" && !globals[STARTED]) {
	globals[STARTED] = true
	// Keep the real timer: tests install fake timers, which would stop the loop.
	const realSetTimeout = globalThis.setTimeout
	const block = range(process.env.KIMCHI_TEST_JITTER_BLOCK_MS, [60, 120])
	const gap = range(process.env.KIMCHI_TEST_JITTER_GAP_MS, [5, 30])
	// Mix in the worker id so workers differ. Which worker runs a file depends
	// on scheduling, so a seed repeats a single-file run, not a full suite.
	const seed = Number(process.env.KIMCHI_TEST_JITTER_SEED ?? "1") * 1000 + Number(process.env.VITEST_POOL_ID ?? "0")
	const random = prng(Number.isFinite(seed) ? seed : 1)
	const between = ([min, max]: [number, number]) => min + Math.floor(random() * (max - min + 1))
	// Atomics.wait blocks the thread without reading a clock, so mocked Date
	// or performance cannot turn it into an endless loop.
	const cell = new Int32Array(new SharedArrayBuffer(4))
	const tick = () => {
		Atomics.wait(cell, 0, 0, between(block))
		realSetTimeout(tick, between(gap)).unref()
	}
	realSetTimeout(tick, between(gap)).unref()
}
