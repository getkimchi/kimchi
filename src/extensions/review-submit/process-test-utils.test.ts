import { describe, expect, it } from "vitest"
import { stripExpectedNodeWarnings } from "./process-test-utils.js"

const sqliteWarning =
	"(node:26497) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n"
const tsxDeprecation =
	"(node:26497) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.\n(Use `node --trace-deprecation ...` to show where the warning was created)\n"

describe("stripExpectedNodeWarnings", () => {
	it("removes exactly Node's experimental SQLite warning pair", () => {
		expect(stripExpectedNodeWarnings(sqliteWarning)).toBe("")
		expect(stripExpectedNodeWarnings(`${sqliteWarning}Error: rejected\n`)).toBe("Error: rejected\n")
	})

	it("removes exactly Node 26's tsx module.register() deprecation pair", () => {
		expect(stripExpectedNodeWarnings(tsxDeprecation)).toBe("")
		expect(stripExpectedNodeWarnings(`${tsxDeprecation}Error: rejected\n`)).toBe("Error: rejected\n")
		expect(stripExpectedNodeWarnings(tsxDeprecation.replaceAll("\n", "\r\n"))).toBe("")
	})

	it("removes both warnings in the order Node prints them", () => {
		expect(stripExpectedNodeWarnings(`${tsxDeprecation}${sqliteWarning}`)).toBe("")
		expect(stripExpectedNodeWarnings(`${tsxDeprecation}${sqliteWarning}Error: rejected\n`)).toBe("Error: rejected\n")
	})

	it("keeps the tsx deprecation when it follows the SQLite warning, which Node never does", () => {
		expect(stripExpectedNodeWarnings(`${sqliteWarning}${tsxDeprecation}`)).toBe(tsxDeprecation)
	})

	it("keeps a known warning that is not at the start of stderr", () => {
		const late = `Error: rejected\n${tsxDeprecation}`
		expect(stripExpectedNodeWarnings(late)).toBe(late)
	})

	it("keeps other deprecation warnings", () => {
		const other =
			"(node:26497) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n(Use `node --trace-deprecation ...` to show where the warning was created)\n"
		expect(stripExpectedNodeWarnings(other)).toBe(other)
	})

	it("preserves every other stderr diagnostic", () => {
		const diagnostic = "Warning: unrelated behavior\nTrace: submitted by the test\n"
		expect(stripExpectedNodeWarnings(diagnostic)).toBe(diagnostic)
	})
})
