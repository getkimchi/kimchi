import { describe, expect, it } from "vitest"
import { applyEditInput, applyEdits, normaliseEditOperations } from "./edit-apply.js"

describe("normaliseEditOperations", () => {
	it("normalises the single-operation form", () => {
		const ops = normaliseEditOperations({ oldText: "a", newText: "b" })
		expect(ops).toEqual([{ oldText: "a", newText: "b" }])
	})

	it("normalises the single-operation form with snake_case fallbacks", () => {
		const ops = normaliseEditOperations({ old_text: "a", new_text: "b" })
		expect(ops).toEqual([{ oldText: "a", newText: "b" }])
	})

	it("normalises the array form", () => {
		const ops = normaliseEditOperations({
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		})
		expect(ops).toEqual([
			{ oldText: "a", newText: "b" },
			{ oldText: "c", newText: "d" },
		])
	})

	it("normalises the array form with snake_case fallbacks", () => {
		const ops = normaliseEditOperations({
			edits: [{ old_text: "a", new_text: "b" }],
		})
		expect(ops).toEqual([{ oldText: "a", newText: "b" }])
	})

	it("filters out empty oldText", () => {
		const ops = normaliseEditOperations({ edits: [{ oldText: "", newText: "b" }] })
		expect(ops).toEqual([])
	})

	it("filters out no-op edits where oldText === newText", () => {
		const ops = normaliseEditOperations({ edits: [{ oldText: "a", newText: "a" }] })
		expect(ops).toEqual([])
	})

	it("returns an empty array when no edits are present", () => {
		const ops = normaliseEditOperations({})
		expect(ops).toEqual([])
	})
})

describe("applyEdits", () => {
	it("applies a single operation", () => {
		expect(applyEdits("hello world", [{ oldText: "world", newText: "kimchi" }])).toBe("hello kimchi")
	})

	it("applies multiple operations sequentially", () => {
		expect(
			applyEdits("a b c", [
				{ oldText: "a", newText: "x" },
				{ oldText: "b", newText: "y" },
				{ oldText: "c", newText: "z" },
			]),
		).toBe("x y z")
	})

	it("replaces only the first occurrence", () => {
		expect(applyEdits("a a a", [{ oldText: "a", newText: "x" }])).toBe("x a a")
	})

	it("returns null when oldText is not found", () => {
		expect(applyEdits("hello", [{ oldText: "world", newText: "kimchi" }])).toBeNull()
	})

	it("returns null when a later operation's oldText is not found after earlier mutations", () => {
		// After replacing "a" with "x", "a" is no longer present
		expect(
			applyEdits("a b", [
				{ oldText: "a", newText: "x" },
				{ oldText: "a", newText: "y" },
			]),
		).toBeNull()
	})

	it("can insert text by matching an empty-ish anchor via surrounding context", () => {
		// oldText with surrounding context acts as an insertion point
		expect(applyEdits("function() {}", [{ oldText: "()", newText: "(arg)" }])).toBe("function(arg) {}")
	})

	it("returns the original when operations is empty", () => {
		expect(applyEdits("hello", [])).toBe("hello")
	})

	it("handles multi-line oldText", () => {
		const original = "line1\nline2\nline3"
		const oldText = "line1\nline2"
		const newText = "line1\nLINE2"
		expect(applyEdits(original, [{ oldText, newText }])).toBe("line1\nLINE2\nline3")
	})

	it("handles large content efficiently", () => {
		const original = "x".repeat(100_000)
		const newText = "y".repeat(100_000)
		expect(applyEdits(original, [{ oldText: original, newText }])).toBe(newText)
	})
})

describe("applyEditInput", () => {
	it("normalises and applies the single-operation form", () => {
		expect(applyEditInput("hello world", { oldText: "world", newText: "kimchi" })).toBe("hello kimchi")
	})

	it("normalises and applies the array form", () => {
		expect(
			applyEditInput("a b c", {
				edits: [
					{ oldText: "a", newText: "x" },
					{ oldText: "c", newText: "z" },
				],
			}),
		).toBe("x b z")
	})

	it("returns null when an operation fails", () => {
		expect(
			applyEditInput("hello", {
				edits: [{ oldText: "world", newText: "kimchi" }],
			}),
		).toBeNull()
	})

	it("returns the original when no operations are present", () => {
		expect(applyEditInput("hello", {})).toBe("hello")
	})
})
