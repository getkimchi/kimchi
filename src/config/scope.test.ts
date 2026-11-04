// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseScope, resolveScopePath } from "./scope.js"

describe("resolveScopePath", () => {
	it("expands ~/ at the start of a global path", () => {
		expect(resolveScopePath("global", "~/.config/opencode/opencode.json")).toBe(
			join(homedir(), ".config/opencode/opencode.json"),
		)
	})

	it("returns absolute global paths verbatim", () => {
		expect(resolveScopePath("global", "/etc/foo")).toBe("/etc/foo")
	})

	it("expands lone ~ to homedir", () => {
		expect(resolveScopePath("global", "~")).toBe(homedir())
	})

	it("project scope places the file in <cwd>/.claude/<basename>", () => {
		const result = resolveScopePath("project", "~/.config/opencode/opencode.json")
		expect(result).toBe(join(process.cwd(), ".claude", "opencode.json"))
	})

	it("project scope strips deep parent directories", () => {
		const result = resolveScopePath("project", "/some/deep/path/to/file.json")
		expect(result).toBe(join(process.cwd(), ".claude", "file.json"))
	})
})

describe("parseScope", () => {
	it("defaults to global for undefined", () => {
		expect(parseScope(undefined)).toBe("global")
	})

	it("defaults to global for empty string", () => {
		expect(parseScope("")).toBe("global")
	})

	it("returns global and project unchanged", () => {
		expect(parseScope("global")).toBe("global")
		expect(parseScope("project")).toBe("project")
	})

	it("throws on invalid scope", () => {
		expect(() => parseScope("bogus")).toThrow(/Invalid scope/)
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
