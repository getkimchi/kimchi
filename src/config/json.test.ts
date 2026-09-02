import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readJson, writeFileAtomic, writeJson } from "./json.js"

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

	it("writeFileAtomic writes raw text", () => {
		const path = join(dir, ".env")
		writeFileAtomic(path, "FOO=bar\n")
		expect(readFileSync(path, "utf-8")).toBe("FOO=bar\n")
	})
})
