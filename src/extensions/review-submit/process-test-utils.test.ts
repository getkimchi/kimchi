import { describe, expect, it } from "vitest"
import { stripExpectedNodeSqliteWarning } from "./process-test-utils.js"

const warning =
	"(node:26497) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n"

describe("stripExpectedNodeSqliteWarning", () => {
	it("removes exactly Node's experimental SQLite warning pair", () => {
		expect(stripExpectedNodeSqliteWarning(warning)).toBe("")
		expect(stripExpectedNodeSqliteWarning(`${warning}Error: rejected\n`)).toBe("Error: rejected\n")
	})

	it("preserves every other stderr diagnostic", () => {
		const diagnostic = "Warning: unrelated behavior\nTrace: submitted by the test\n"
		expect(stripExpectedNodeSqliteWarning(diagnostic)).toBe(diagnostic)
	})
})
