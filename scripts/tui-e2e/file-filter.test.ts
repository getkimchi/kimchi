import { readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { exactFileFilter } from "./file-filter.js"

const tuiDir = resolve(import.meta.dirname, "../../tests/e2e/tui")

// Same transformation tui-test 0.0.4 applies before it builds the RegExp.
const asTuiTestRegExp = (filter: string) => new RegExp(filter.replaceAll("\\", "\\\\"))

describe("exactFileFilter", () => {
	it("matches the file and not a longer file that starts with the same stem", () => {
		const filter = asTuiTestRegExp(exactFileFilter("side-chat"))
		expect(filter.test("/repo/tests/e2e/tui/side-chat.test.ts")).toBe(true)
		expect(filter.test("/repo/tests/e2e/tui/side-chat-permission-ask.test.ts")).toBe(false)
	})

	it("does not match a file whose name ends with the stem", () => {
		const filter = asTuiTestRegExp(exactFileFilter("read-image"))
		expect(filter.test("/repo/tests/e2e/tui/continue-read-image.test.ts")).toBe(false)
	})

	it("matches Windows paths", () => {
		const filter = asTuiTestRegExp(exactFileFilter("side-chat"))
		expect(filter.test("C:\\repo\\tests\\e2e\\tui\\side-chat.test.ts")).toBe(true)
	})

	it("treats regex characters in the stem as plain text", () => {
		const filter = asTuiTestRegExp(exactFileFilter("a.b"))
		expect(filter.test("/repo/a.b.test.ts")).toBe(true)
		expect(filter.test("/repo/axb.test.ts")).toBe(false)
	})

	it("selects exactly one file for every TUI e2e test file", () => {
		const paths = readdirSync(tuiDir)
			.filter((name) => name.endsWith(".test.ts"))
			.map((name) => join(tuiDir, name))
		expect(paths.length).toBeGreaterThan(0)
		for (const path of paths) {
			const stem = path.slice(tuiDir.length + 1, -".test.ts".length)
			const filter = asTuiTestRegExp(exactFileFilter(stem))
			expect(paths.filter((candidate) => filter.test(candidate))).toEqual([path])
		}
	})
})
