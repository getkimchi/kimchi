import { describe, expect, it } from "vitest"
import { codemodePurpose } from "./purpose.js"

describe("codemodePurpose", () => {
	it("reads and normalizes a first-line purpose", () => {
		expect(codemodePurpose({ code: "// @description:  Filter   files   by name \nreturn 'ok';" })).toBe(
			"Filter files by name",
		)
	})

	it("reads purpose immediately after @options", () => {
		expect(
			codemodePurpose({ code: '// @options: {"max_output_tokens": 40}\n// @description: Filter files\nreturn "ok";' }),
		).toBe("Filter files")
	})

	it("accepts exactly 120 characters", () => {
		expect(codemodePurpose({ code: `// @description: ${"x".repeat(120)}` })).toHaveLength(120)
	})

	it("handles a CRLF @options line", () => {
		expect(codemodePurpose({ code: "// @options: {}\r\n// @description: Filter files\r\nreturn 1" })).toBe(
			"Filter files",
		)
	})

	// JavaScript ends a line comment at any of these, so the code after one is
	// executable source and must never become part of the title.
	it.each([
		["CRLF", "\r\n"],
		["CR", "\r"],
		["LINE SEPARATOR", "\u2028"],
		["PARAGRAPH SEPARATOR", "\u2029"],
	])("ends the purpose at a %s line terminator", (_name, terminator) => {
		expect(codemodePurpose({ code: `// @description: Filter${terminator}return 42` })).toBe("Filter")
		expect(codemodePurpose({ code: `// @options: {}${terminator}// @description: Filter${terminator}return 42` })).toBe(
			"Filter",
		)
	})
})

describe("codemodePurpose invalid metadata", () => {
	it.each([
		"// @description: Filter files\n// @options: {}",
		"// @description: Filter files\u2028// @options: {}",
		"const x = 1;\n// @description: Late purpose",
		`// @description: ${"x".repeat(121)}`,
		"// @description:    \nreturn 1",
	])("returns the fallback for invalid purpose metadata: %j", (code) => {
		expect(codemodePurpose({ code })).toBeUndefined()
	})
})
