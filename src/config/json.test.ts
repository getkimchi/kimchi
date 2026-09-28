import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	__resetJsonCacheForTest,
	invalidateJsonCache,
	readJson,
	readJsonCached,
	writeFileAtomic,
	writeJson,
} from "./json.js"

describe("readJson / writeJson", () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-json-test-"))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it("returns {} when the file is missing", () => {
		expect(readJson(join(dir, "missing.json"))).toEqual({})
	})

	it("parses a real JSON file", () => {
		const path = join(dir, "config.json")
		writeFileSync(path, '{"a":1,"b":"x"}', "utf-8")
		expect(readJson(path)).toEqual({ a: 1, b: "x" })
	})

	it("falls back to .jsonc when the .json sibling is missing", () => {
		const jsoncPath = join(dir, "settings.jsonc")
		writeFileSync(jsoncPath, '// header\n{"x": 1}\n', "utf-8")
		expect(readJson(join(dir, "settings.json"))).toEqual({ x: 1 })
	})

	it("strips // line comments and /* block */ comments before parsing", () => {
		const path = join(dir, "c.jsonc")
		writeFileSync(path, '{\n  // comment\n  "a": 1, /* mid */ "b": 2\n}\n', "utf-8")
		expect(readJson(path)).toEqual({ a: 1, b: 2 })
	})

	it("does not strip slashes inside string values", () => {
		const path = join(dir, "url.json")
		writeFileSync(path, '{"url":"https://example.com/path"}', "utf-8")
		expect(readJson(path)).toEqual({ url: "https://example.com/path" })
	})

	it("normalises a literal `null` to {}", () => {
		const path = join(dir, "null.json")
		writeFileSync(path, "null", "utf-8")
		expect(readJson(path)).toEqual({})
	})

	it("returns {} for an empty file (existing but 0 bytes)", () => {
		const path = join(dir, "empty.json")
		writeFileSync(path, "", "utf-8")
		expect(readJson(path)).toEqual({})
	})

	it("returns {} for a whitespace- and comment-only file", () => {
		const path = join(dir, "comments-only.jsonc")
		writeFileSync(path, "// just a comment\n/* and a block */\n   \n", "utf-8")
		expect(readJson(path)).toEqual({})
	})

	it("throws on malformed JSON instead of silently swallowing", () => {
		const path = join(dir, "bad.json")
		writeFileSync(path, '{"a": ', "utf-8")
		expect(() => readJson(path)).toThrow()
	})

	it("writeJson creates parent dirs and writes pretty JSON with trailing newline", () => {
		const path = join(dir, "nested", "x.json")
		writeJson(path, { foo: "bar", n: 7 })
		expect(readFileSync(path, "utf-8")).toBe(`${JSON.stringify({ foo: "bar", n: 7 }, null, 2)}\n`)
	})

	it("writeJson is atomic — temp file is gone, only the destination remains", () => {
		const path = join(dir, "atomic.json")
		writeJson(path, { ok: true })
		expect(readFileSync(path, "utf-8")).toContain('"ok": true')
		// No leftover .tmp files in the same directory
		const leftover = readFileSync(path, "utf-8")
		expect(leftover).not.toContain("tmp")
	})

	describe("readJsonCached", () => {
		let dir: string

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "kimchi-json-cache-test-"))
			__resetJsonCacheForTest()
		})

		afterEach(() => {
			rmSync(dir, { recursive: true, force: true })
			__resetJsonCacheForTest()
		})

		it("serves the cached object on a second read (same reference → no re-read)", () => {
			const path = join(dir, "config.json")
			writeFileSync(path, '{"a":1}', "utf-8")
			const first = readJsonCached(path)
			const second = readJsonCached(path)
			expect(second).toEqual({ a: 1 })
			// JSON.parse builds a fresh object per read, so reference identity is
			// proof the second call never touched the file.
			expect(second).toBe(first)
		})

		it("re-reads when mtime changes (content and size unchanged)", () => {
			const path = join(dir, "config.json")
			writeFileSync(path, '{"a":1}', "utf-8")
			const first = readJsonCached(path)
			// Touch the file: only the mtime moves.
			const t = new Date(Date.now() + 10_000)
			utimesSync(path, t, t)
			const second = readJsonCached(path)
			expect(second).toEqual({ a: 1 })
			expect(second).not.toBe(first)
		})

		it("re-reads when only the size changes (mtime pinned back)", () => {
			const path = join(dir, "config.json")
			writeFileSync(path, '{"a":1}', "utf-8")
			// Baseline mtime to a whole second so the pin-back below round-trips
			// exactly (Date keeps only ms; APFS mtimes carry ns).
			const baseline = new Date(Math.floor(Date.now() / 1000) * 1000)
			utimesSync(path, baseline, baseline)
			readJsonCached(path)
			writeFileSync(path, '{"a":12}', "utf-8")
			// Pin mtime back so ONLY the size differs from the cached signature.
			utimesSync(path, baseline, baseline)
			expect(readJsonCached(path)).toEqual({ a: 12 })
		})

		it("caches a missing file as {} and re-reads once it is created", () => {
			const path = join(dir, "created.json")
			expect(readJsonCached(path)).toEqual({})
			expect(readJsonCached(path)).toEqual({}) // cached miss
			writeFileSync(path, '{"b":2}', "utf-8")
			expect(readJsonCached(path)).toEqual({ b: 2 })
		})

		it("caches the .jsonc fallback value while the primary is absent; primary wins later", () => {
			const primary = join(dir, "settings.json")
			writeFileSync(`${primary}c`, '{"x":1}', "utf-8")
			const first = readJsonCached(primary)
			expect(first).toEqual({ x: 1 })
			expect(readJsonCached(primary)).toBe(first)
			// The primary appearing later takes over, exactly like readJson.
			writeFileSync(primary, '{"x":2}', "utf-8")
			expect(readJsonCached(primary)).toEqual({ x: 2 })
		})

		it("has the same JSONC tolerance as readJson", () => {
			const path = join(dir, "comments.jsonc")
			writeFileSync(path, '{\n  // comment\n  "a": 1\n}\n', "utf-8")
			expect(readJsonCached(path)).toEqual({ a: 1 })
		})

		it("writeJson invalidates the cached value", () => {
			const path = join(dir, "w.json")
			writeJson(path, { a: 1 })
			readJsonCached(path)
			writeJson(path, { a: 2 })
			expect(readJsonCached(path)).toEqual({ a: 2 })
		})

		it("does not cache a parse error — the next call re-reads", () => {
			const path = join(dir, "bad.json")
			writeFileSync(path, '{"a": ', "utf-8")
			expect(() => readJsonCached(path)).toThrow()
			writeFileSync(path, '{"a": 1}', "utf-8")
			expect(readJsonCached(path)).toEqual({ a: 1 })
		})

		it("invalidateJsonCache drops only the given path", () => {
			const a = join(dir, "a.json")
			const b = join(dir, "b.json")
			writeFileSync(a, '{"k":"a"}', "utf-8")
			writeFileSync(b, '{"k":"b"}', "utf-8")
			const a1 = readJsonCached(a)
			const b1 = readJsonCached(b)
			invalidateJsonCache(a)
			expect(readJsonCached(a)).not.toBe(a1)
			expect(readJsonCached(b)).toBe(b1)
		})

		it("__resetJsonCacheForTest clears cached values", () => {
			const path = join(dir, "r.json")
			writeFileSync(path, '{"a":1}', "utf-8")
			const first = readJsonCached(path)
			__resetJsonCacheForTest()
			expect(readJsonCached(path)).toEqual({ a: 1 })
			expect(readJsonCached(path)).not.toBe(first)
		})

		it("caches per resolved path", () => {
			writeFileSync(join(dir, "a.json"), '{"k":"a"}', "utf-8")
			writeFileSync(join(dir, "b.json"), '{"k":"b"}', "utf-8")
			expect(readJsonCached(join(dir, "a.json"))).toEqual({ k: "a" })
			expect(readJsonCached(join(dir, "b.json"))).toEqual({ k: "b" })
		})
	})

	it("writeFileAtomic writes raw text", () => {
		const path = join(dir, ".env")
		writeFileAtomic(path, "FOO=bar\n")
		expect(readFileSync(path, "utf-8")).toBe("FOO=bar\n")
	})
})
