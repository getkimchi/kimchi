// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { describe, expect, it, vi } from "vitest"
import { Cache, MAX_ENTRIES } from "./cache.js"

describe("Cache.key", () => {
	it("combines URL and format with :: separator", () => {
		expect(Cache.key("https://example.com/", "markdown")).toBe("https://example.com/::markdown")
	})

	it("produces different keys for different formats", () => {
		const md = Cache.key("https://example.com/", "markdown")
		const txt = Cache.key("https://example.com/", "text")
		const html = Cache.key("https://example.com/", "html")
		expect(md).not.toBe(txt)
		expect(md).not.toBe(html)
		expect(txt).not.toBe(html)
	})

	it("produces different keys for different URLs", () => {
		const a = Cache.key("https://a.com/", "markdown")
		const b = Cache.key("https://b.com/", "markdown")
		expect(a).not.toBe(b)
	})
})

describe("get / set", () => {
	it("returns undefined on cache miss", () => {
		const cache = new Cache()
		expect(cache.get("https://example.com/", "markdown")).toBeUndefined()
	})

	it("returns stored value on cache hit", () => {
		const cache = new Cache()
		cache.set("https://example.com/", "markdown", "cached output")
		expect(cache.get("https://example.com/", "markdown")).toBe("cached output")
	})

	it("returns undefined for same URL but different format", () => {
		const cache = new Cache()
		cache.set("https://example.com/", "markdown", "md output")
		expect(cache.get("https://example.com/", "text")).toBeUndefined()
	})

	it("overwrites existing entry for same key", () => {
		const cache = new Cache()
		cache.set("https://example.com/", "markdown", "first")
		cache.set("https://example.com/", "markdown", "second")
		expect(cache.get("https://example.com/", "markdown")).toBe("second")
	})

	it("stores entries for multiple URLs independently", () => {
		const cache = new Cache()
		cache.set("https://a.com/", "markdown", "output A")
		cache.set("https://b.com/", "markdown", "output B")
		expect(cache.get("https://a.com/", "markdown")).toBe("output A")
		expect(cache.get("https://b.com/", "markdown")).toBe("output B")
	})
})

describe("TTL expiry", () => {
	it("returns undefined after TTL has elapsed", () => {
		const cache = new Cache({ ttlMs: 100 })
		cache.set("https://example.com/", "markdown", "cached")

		vi.useFakeTimers()
		vi.advanceTimersByTime(150)

		expect(cache.get("https://example.com/", "markdown")).toBeUndefined()
		vi.useRealTimers()
	})

	it("returns value within TTL", () => {
		const cache = new Cache({ ttlMs: 1000 })
		cache.set("https://example.com/", "markdown", "cached")

		expect(cache.get("https://example.com/", "markdown")).toBe("cached")
	})

	it("evicts expired entry on access", () => {
		const cache = new Cache({ ttlMs: 100 })
		cache.set("https://example.com/", "markdown", "cached")
		expect(cache.size).toBe(1)

		vi.useFakeTimers()
		vi.advanceTimersByTime(150)

		cache.get("https://example.com/", "markdown") // triggers eviction
		expect(cache.size).toBe(0)
		vi.useRealTimers()
	})
})

describe("clear", () => {
	it("removes all entries", () => {
		const cache = new Cache()
		cache.set("https://a.com/", "markdown", "a")
		cache.set("https://b.com/", "text", "b")
		cache.set("https://c.com/", "html", "c")
		expect(cache.size).toBe(3)

		cache.clear()
		expect(cache.size).toBe(0)
		expect(cache.get("https://a.com/", "markdown")).toBeUndefined()
		expect(cache.get("https://b.com/", "text")).toBeUndefined()
		expect(cache.get("https://c.com/", "html")).toBeUndefined()
	})

	it("is safe to call on empty cache", () => {
		const cache = new Cache()
		expect(cache.size).toBe(0)
		cache.clear() // should not throw
		expect(cache.size).toBe(0)
	})
})

describe("size", () => {
	it("returns 0 for empty cache", () => {
		const cache = new Cache()
		expect(cache.size).toBe(0)
	})

	it("reflects number of stored entries", () => {
		const cache = new Cache()
		cache.set("https://a.com/", "markdown", "a")
		expect(cache.size).toBe(1)
		cache.set("https://b.com/", "text", "b")
		expect(cache.size).toBe(2)
	})
})

describe("cache eviction", () => {
	it("evicts the oldest entry when inserting beyond maxEntries", () => {
		const cache = new Cache()
		for (let i = 0; i < MAX_ENTRIES; i++) {
			cache.set(`https://${i}.com/`, "markdown", `output-${i}`)
		}
		expect(cache.size).toBe(MAX_ENTRIES)

		// Insert one more — should evict entry 0 (the oldest)
		cache.set("https://new.com/", "markdown", "new-output")
		expect(cache.size).toBe(MAX_ENTRIES)
		expect(cache.get("https://0.com/", "markdown")).toBeUndefined()
		expect(cache.get("https://new.com/", "markdown")).toBe("new-output")
	})

	it("retains newest entries and evicts oldest", () => {
		const cache = new Cache()
		for (let i = 0; i < MAX_ENTRIES; i++) {
			cache.set(`https://${i}.com/`, "markdown", `output-${i}`)
		}

		// Insert 3 more entries — should evict entries 0, 1, 2
		cache.set("https://new-a.com/", "markdown", "a")
		cache.set("https://new-b.com/", "markdown", "b")
		cache.set("https://new-c.com/", "markdown", "c")

		expect(cache.size).toBe(MAX_ENTRIES)

		// Oldest 3 evicted
		expect(cache.get("https://0.com/", "markdown")).toBeUndefined()
		expect(cache.get("https://1.com/", "markdown")).toBeUndefined()
		expect(cache.get("https://2.com/", "markdown")).toBeUndefined()

		// Newest 3 present
		expect(cache.get("https://new-a.com/", "markdown")).toBe("a")
		expect(cache.get("https://new-b.com/", "markdown")).toBe("b")
		expect(cache.get("https://new-c.com/", "markdown")).toBe("c")

		// Last original entry still present
		expect(cache.get(`https://${MAX_ENTRIES - 1}.com/`, "markdown")).toBe(`output-${MAX_ENTRIES - 1}`)
	})

	it("does not evict when overwriting an existing key at capacity", () => {
		const cache = new Cache()
		for (let i = 0; i < MAX_ENTRIES; i++) {
			cache.set(`https://${i}.com/`, "markdown", `output-${i}`)
		}

		// Overwrite existing key — should NOT evict anything
		cache.set("https://0.com/", "markdown", "updated")
		expect(cache.size).toBe(MAX_ENTRIES)
		expect(cache.get("https://0.com/", "markdown")).toBe("updated")
		expect(cache.get("https://1.com/", "markdown")).toBe("output-1")
	})

	it("respects custom maxEntries option", () => {
		const cache = new Cache({ maxEntries: 3 })
		cache.set("https://a.com/", "markdown", "a")
		cache.set("https://b.com/", "markdown", "b")
		cache.set("https://c.com/", "markdown", "c")
		cache.set("https://d.com/", "markdown", "d")

		expect(cache.size).toBe(3)
		expect(cache.get("https://a.com/", "markdown")).toBeUndefined()
		expect(cache.get("https://d.com/", "markdown")).toBe("d")
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
