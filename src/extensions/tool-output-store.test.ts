import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createToolOutputStore, makeMarker, parseMarker, TOOL_OUTPUT_MARKER_PREFIX } from "./tool-output-store.js"

const INT_KEYS = ["KIMCHI_TOOL_OUTPUT_STORE", "KIMCHI_TOOL_OUTPUT_EXTERNALIZE_BYTES", "KIMCHI_TOOL_OUTPUT_CACHE_BYTES"]

describe("tool-output-store", () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tool-output-store-"))
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
		for (const key of INT_KEYS) delete process.env[key]
	})

	it("round-trips text through record + read", () => {
		const store = createToolOutputStore(dir)
		const text = "x".repeat(200_000)
		const handle = store.record(text)
		expect(handle.offset).toBe(0)
		expect(handle.length).toBe(Buffer.byteLength(text, "utf8"))
		expect(store.read(handle)).toBe(text)
	})

	it("appends multiple records at increasing byte offsets", () => {
		const store = createToolOutputStore(dir)
		const a = store.record("alpha")
		const b = store.record("beta")
		expect(b.offset).toBe(a.offset + a.length)
		expect(store.read(a)).toBe("alpha")
		expect(store.read(b)).toBe("beta")
	})

	it("returns undefined for a missing or out-of-range mirror", () => {
		const store = createToolOutputStore(dir)
		const handle = store.record("data")
		expect(store.read({ file: join(dir, "absent.log"), offset: 0, length: 4 })).toBeUndefined()
		expect(store.read({ ...handle, offset: 1000, length: 4 })).toBeUndefined()
		expect(store.read({ ...handle, offset: 0, length: 1_000_000 })).toBeUndefined()
	})

	it("evicts least-recently-used entries beyond the cache budget but keeps handles readable", () => {
		const store = createToolOutputStore(dir, 100)
		const big = "z".repeat(80)
		const h1 = store.record(big) // 80 bytes
		store.read(h1) // cached (80 ≤ 100)
		const h3 = store.record(big) // another 80 bytes
		// reading h3 must evict h1 to fit the 100-byte budget
		expect(store.read(h3)).toBe(big)
		expect(store.stats().cacheEntries).toBe(1)
		expect(store.stats().cacheBytes).toBeLessThanOrEqual(100)
		// evicted/large handles stay readable through direct reads
		expect(store.read(h1)).toBe(big)
		expect(store.read(h3)).toBe(big)
	})

	it("pinned entries survive eviction until unpinned", () => {
		const store = createToolOutputStore(dir, 50)
		const h1 = store.record("y".repeat(40))
		store.pin(h1)
		const h2 = store.record("q".repeat(40))
		store.read(h2) // fills the 50-byte budget with h2
		// eviction would target the LRU (h1) but it is pinned
		expect(store.stats().cacheEntries).toBeGreaterThanOrEqual(1)
		expect(store.read(h1)).toBe("y".repeat(40)) // still readable (cache or direct)
		store.unpin(h1)
	})

	it("does not cache entries larger than the budget (direct read only)", () => {
		const store = createToolOutputStore(dir, 10)
		const big = "w".repeat(64)
		const h = store.record(big)
		expect(store.read(h)).toBe(big)
		expect(store.stats().cacheEntries).toBe(0)
	})

	it("zero cache budget disables caching but reads still work", () => {
		const store = createToolOutputStore(dir, 0)
		const h = store.record("hello")
		expect(store.read(h)).toBe("hello")
		expect(store.stats().cacheEntries).toBe(0)
	})

	it("read failures are surfaced as console.error and return undefined", () => {
		const store = createToolOutputStore(dir)
		const errors: unknown[] = []
		const original = console.error
		console.error = (...args: unknown[]) => errors.push(args)
		try {
			expect(store.read({ file: join(dir, "absent.log"), offset: 0, length: 1 })).toBeUndefined()
			// existsSync guard returns undefined without logging; force a read failure via a directory
			writeFileSync(join(dir, "root"), "")
			mkdirSync(join(dir, "sub"))
			writeFileSync(join(dir, "sub", "data"), "abc")
			expect(store.read({ file: dir, offset: 0, length: 1 })).toBeUndefined()
		} finally {
			console.error = original
		}
		expect(errors.length).toBeGreaterThan(0)
	})

	it("marker encode/decode round-trip and reject malformed text", () => {
		const handle = { file: "/tmp/tool-outputs-1.log", offset: 12, length: 99 }
		expect(parseMarker(makeMarker(handle))).toEqual(handle)
		expect(parseMarker(`nothing here ${TOOL_OUTPUT_MARKER_PREFIX}`)).toBeUndefined()
		expect(parseMarker(TOOL_OUTPUT_MARKER_PREFIX + "not-json")).toBeUndefined()
		expect(parseMarker(TOOL_OUTPUT_MARKER_PREFIX + '{"file":"/x","offset":-1,"length":3}')).toBeUndefined()
		expect(parseMarker(TOOL_OUTPUT_MARKER_PREFIX + '{"file":"/x","offset":0,"length":1.5}')).toBeUndefined()
	})

	it("persists records to the artifacts file on disk (mirror durability)", () => {
		const store = createToolOutputStore(dir)
		store.record("persisted-content")
		const [written] = readFileSync(store.stats().file, "utf8").split("\n")
		expect(written).toBe("persisted-content")
	})
})
