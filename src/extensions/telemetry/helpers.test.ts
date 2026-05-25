import { describe, expect, it } from "vitest"
import {
	computeLineChanges,
	computeWriteLines,
	countLineChanges,
	extractFilePath,
	hashFilePath,
	inferLanguage,
	nowNano,
	strAttr,
	toAttrs,
} from "./helpers.js"

describe("nowNano", () => {
	it("returns a string of nanoseconds > 0", () => {
		const result = nowNano()
		expect(typeof result).toBe("string")
		expect(Number(result)).toBeGreaterThan(0)
	})

	it("returns a value approximately equal to Date.now() * 1_000_000", () => {
		const before = Date.now() * 1_000_000
		const result = Number(nowNano())
		const after = Date.now() * 1_000_000
		expect(result).toBeGreaterThanOrEqual(before)
		expect(result).toBeLessThanOrEqual(after)
	})
})

describe("strAttr", () => {
	it("builds correct OTLP attribute shape", () => {
		const attr = strAttr("service.name", "kimchi")
		expect(attr).toEqual({
			key: "service.name",
			value: { stringValue: "kimchi" },
		})
	})

	it("handles empty strings", () => {
		const attr = strAttr("", "")
		expect(attr).toEqual({
			key: "",
			value: { stringValue: "" },
		})
	})
})

describe("inferLanguage", () => {
	it("maps .ts to TypeScript", () => {
		expect(inferLanguage("src/index.ts")).toBe("TypeScript")
	})

	it("maps .tsx to TypeScript", () => {
		expect(inferLanguage("component.tsx")).toBe("TypeScript")
	})

	it("maps .py to Python", () => {
		expect(inferLanguage("script.py")).toBe("Python")
	})

	it("maps .go to Go", () => {
		expect(inferLanguage("main.go")).toBe("Go")
	})

	it("maps Dockerfile to Dockerfile", () => {
		expect(inferLanguage("Dockerfile")).toBe("Dockerfile")
	})

	it("returns unknown for unrecognized extensions", () => {
		expect(inferLanguage("file.xyz")).toBe("unknown")
	})

	it("is case-insensitive for extensions", () => {
		expect(inferLanguage("README.MD")).toBe("Markdown")
	})

	it("handles files with multiple dots", () => {
		expect(inferLanguage("my.component.test.ts")).toBe("TypeScript")
	})

	it("returns unknown for extensionless files that are not in the map", () => {
		expect(inferLanguage("Makefile")).toBe("unknown")
	})
})

describe("countLineChanges", () => {
	it("counts added lines (1-line to 2-line)", () => {
		const result = countLineChanges("old line\n", "new line 1\nnew line 2\n")
		expect(result.added).toBe(1)
		expect(result.removed).toBe(0)
	})

	it("counts removed lines (2-line to 1-line)", () => {
		const result = countLineChanges("line 1\nline 2\n", "line 1\n")
		expect(result.removed).toBe(1)
		expect(result.added).toBe(0)
	})

	it("returns (0, 0) for identical strings", () => {
		const result = countLineChanges("same\n", "same\n")
		expect(result.added).toBe(0)
		expect(result.removed).toBe(0)
	})

	it("counts 1 added for a single-line content change", () => {
		const result = countLineChanges("old", "new")
		expect(result.added).toBe(1)
		expect(result.removed).toBe(0)
	})

	it("handles empty old string", () => {
		const result = countLineChanges("", "new line\n")
		expect(result.added).toBeGreaterThan(0)
	})

	it("handles empty new string", () => {
		const result = countLineChanges("old line\n", "")
		expect(result.removed).toBeGreaterThan(0)
	})
})

describe("hashFilePath", () => {
	it("returns a 12-character hex string", () => {
		const hash = hashFilePath("/tmp/example.ts")
		expect(hash).toHaveLength(12)
		expect(hash).toMatch(/^[0-9a-f]{12}$/)
	})

	it("is deterministic (same input = same output)", () => {
		const hash1 = hashFilePath("/tmp/example.ts")
		const hash2 = hashFilePath("/tmp/example.ts")
		expect(hash1).toBe(hash2)
	})

	it("produces different outputs for different inputs", () => {
		const hash1 = hashFilePath("/tmp/file-a.ts")
		const hash2 = hashFilePath("/tmp/file-b.ts")
		expect(hash1).not.toBe(hash2)
	})

	it("handles empty string", () => {
		const hash = hashFilePath("")
		expect(hash).toHaveLength(12)
		expect(hash).toMatch(/^[0-9a-f]{12}$/)
	})
})

describe("toAttrs", () => {
	it("passes strings through unchanged", () => {
		const result = toAttrs({ name: "test" })
		expect(result.name).toBe("test")
	})

	it("passes numbers through unchanged", () => {
		const result = toAttrs({ count: 42 })
		expect(result.count).toBe(42)
	})

	it("converts true to 'true'", () => {
		const result = toAttrs({ success: true })
		expect(result.success).toBe("true")
	})

	it("converts false to 'false'", () => {
		const result = toAttrs({ success: false })
		expect(result.success).toBe("false")
	})

	it("handles mixed types", () => {
		const result = toAttrs({ tool_name: "bash", duration_ms: 100, success: true })
		expect(result).toEqual({ tool_name: "bash", duration_ms: 100, success: "true" })
	})
})

describe("computeLineChanges", () => {
	it("sums changes across edits array", () => {
		const result = computeLineChanges("edit", {
			edits: [
				{ oldText: "a\n", newText: "a\nb\n" },
				{ oldText: "c\n", newText: "c\nd\n" },
			],
		})
		expect(result.added).toBe(2)
		expect(result.removed).toBe(0)
	})

	it("handles empty edits array", () => {
		const result = computeLineChanges("edit", { edits: [] })
		expect(result.added).toBe(0)
		expect(result.removed).toBe(0)
	})

	it("handles missing edits field", () => {
		const result = computeLineChanges("edit", {})
		expect(result.added).toBe(0)
		expect(result.removed).toBe(0)
	})

	it("handles single edit with added lines", () => {
		const result = computeLineChanges("edit", {
			edits: [{ oldText: "line1\n", newText: "line1\nline2\n" }],
		})
		expect(result.added).toBe(1)
		expect(result.removed).toBe(0)
	})

	it("handles single edit with removed lines", () => {
		const result = computeLineChanges("edit", {
			edits: [{ oldText: "a\nb\n", newText: "a\n" }],
		})
		expect(result.added).toBe(0)
		expect(result.removed).toBe(1)
	})
})

describe("computeWriteLines", () => {
	it("counts lines correctly", () => {
		expect(computeWriteLines({ content: "line1\nline2\nline3" })).toBe(3)
	})

	it("handles trailing newlines", () => {
		expect(computeWriteLines({ content: "line1\nline2\nline3\n" })).toBe(3)
	})

	it("handles multiple trailing newlines", () => {
		expect(computeWriteLines({ content: "line1\nline2\n\n\n" })).toBe(2)
	})

	it("returns 0 for empty content", () => {
		expect(computeWriteLines({ content: "" })).toBe(0)
	})

	it("returns 0 for missing content", () => {
		expect(computeWriteLines({})).toBe(0)
	})

	it("returns 1 for single-line content", () => {
		expect(computeWriteLines({ content: "hello" })).toBe(1)
	})

	it("returns 0 for content that is only newlines", () => {
		expect(computeWriteLines({ content: "\n\n\n" })).toBe(0)
	})
})

describe("extractFilePath", () => {
	it("extracts from path property", () => {
		expect(extractFilePath({ path: "/tmp/file.ts" })).toBe("/tmp/file.ts")
	})

	it("extracts from filePath property", () => {
		expect(extractFilePath({ filePath: "/tmp/file.ts" })).toBe("/tmp/file.ts")
	})

	it("prefers path over filePath", () => {
		expect(extractFilePath({ path: "/from-path", filePath: "/from-filePath" })).toBe("/from-path")
	})

	it("returns empty string for empty args", () => {
		expect(extractFilePath({})).toBe("")
	})

	it("returns empty string when both are undefined", () => {
		expect(extractFilePath({ other: "value" })).toBe("")
	})
})
