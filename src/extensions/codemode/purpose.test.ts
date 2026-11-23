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
})

describe("codemodePurpose invalid metadata", () => {
	it.each([
		"// @description: Filter files\n// @options: {}",
		"const x = 1;\n// @description: Late purpose",
		`// @description: ${"x".repeat(121)}`,
		"// @description:    \nreturn 1",
	])("returns the fallback for invalid purpose metadata: %j", (code) => {
		expect(codemodePurpose({ code })).toBeUndefined()
	})
})
