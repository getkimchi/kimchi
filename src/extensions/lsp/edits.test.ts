// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
// src/extensions/lsp/edits.test.ts
import { describe, expect, it } from "vitest"
import { applyTextEditsToString } from "./edits.js"

describe("applyTextEditsToString", () => {
	it("applies a single-line replacement", () => {
		const content = "const foo = 1\nconst bar = 2\n"
		const result = applyTextEditsToString(content, [
			{
				range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
				newText: "baz",
			},
		])
		expect(result).toBe("const baz = 1\nconst bar = 2\n")
	})

	it("applies multiple edits in bottom-to-top order", () => {
		const content = "aaa\nbbb\nccc\n"
		const result = applyTextEditsToString(content, [
			{
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
				newText: "AAA",
			},
			{
				range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
				newText: "CCC",
			},
		])
		expect(result).toBe("AAA\nbbb\nCCC\n")
	})

	it("applies a multi-line replacement", () => {
		const content = "function foo() {\n  return 1\n}\n"
		const result = applyTextEditsToString(content, [
			{
				range: { start: { line: 0, character: 9 }, end: { line: 2, character: 1 } },
				newText: "bar() {\n  return 2\n}",
			},
		])
		expect(result).toBe("function bar() {\n  return 2\n}\n")
	})

	it("handles insertion (empty range)", () => {
		const content = "hello world\n"
		const result = applyTextEditsToString(content, [
			{
				range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
				newText: " beautiful",
			},
		])
		expect(result).toBe("hello beautiful world\n")
	})

	it("handles deletion (empty newText)", () => {
		const content = "hello world\n"
		const result = applyTextEditsToString(content, [
			{
				range: { start: { line: 0, character: 5 }, end: { line: 0, character: 11 } },
				newText: "",
			},
		])
		expect(result).toBe("hello\n")
	})

	it("returns content unchanged for empty edits array", () => {
		const content = "unchanged\n"
		expect(applyTextEditsToString(content, [])).toBe("unchanged\n")
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
