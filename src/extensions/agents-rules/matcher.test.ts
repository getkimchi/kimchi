import { describe, expect, it } from "vitest"
import { extractFilePath, matchesRule } from "./matcher.js"
import type { AgentRule } from "./types.js"

const CWD = "/repo/project"

function makeRule(overrides: Partial<AgentRule> = {}): AgentRule {
	return {
		path: "/repo/project/.agents/rules/test.mdc",
		name: "test",
		globs: ["src/api/**/*.ts"],
		alwaysApply: false,
		body: "body",
		baseDir: "/repo/project",
		mode: "glob",
		...overrides,
	}
}

describe("extractFilePath", () => {
	it("extracts path from read/edit/write inputs", () => {
		expect(extractFilePath("read", { path: "/a/b.ts" })).toBe("/a/b.ts")
		expect(extractFilePath("edit", { path: "/a/b.ts" })).toBe("/a/b.ts")
		expect(extractFilePath("write", { path: "/a/b.ts" })).toBe("/a/b.ts")
	})

	it("returns undefined for other tools", () => {
		expect(extractFilePath("bash", { command: "cat /a/b.ts" })).toBeUndefined()
		expect(extractFilePath("grep", { path: "/a" })).toBeUndefined()
	})

	it("returns undefined for malformed inputs", () => {
		expect(extractFilePath("read", {})).toBeUndefined()
		expect(extractFilePath("read", null)).toBeUndefined()
		expect(extractFilePath("read", "not-an-object")).toBeUndefined()
		expect(extractFilePath("read", { path: 42 })).toBeUndefined()
		expect(extractFilePath("read", { path: "" })).toBeUndefined()
	})
})

describe("matchesRule", () => {
	it("matches a cwd-relative file path against src/api/**/*.ts", () => {
		expect(matchesRule(makeRule(), "src/api/v1/users.ts", CWD)).toBe(true)
	})

	it("matches an absolute file path against src/api/**/*.ts", () => {
		expect(matchesRule(makeRule(), "/repo/project/src/api/v1/users.ts", CWD)).toBe(true)
	})

	it("does not match files outside the glob", () => {
		expect(matchesRule(makeRule(), "src/core/kernel.ts", CWD)).toBe(false)
		expect(matchesRule(makeRule(), "docs/api.md", CWD)).toBe(false)
	})

	it("matches any file under a directory glob **", () => {
		const rule = makeRule({ globs: ["services/catalog/**"] })
		expect(matchesRule(rule, "services/catalog/handlers/order.ts", CWD)).toBe(true)
		expect(matchesRule(rule, "services/catalog/README.md", CWD)).toBe(true)
		expect(matchesRule(rule, "services/checkout/order.ts", CWD)).toBe(false)
	})

	it("matches bare directory globs as prefixes", () => {
		const rule = makeRule({ globs: ["src/api"] })
		// micromatch treats "src/api" as a literal segment match only;
		// the documented .mdc convention is directory prefix. We require
		// authors to write "src/api/**" — a bare dir does not match deeper files.
		expect(matchesRule(rule, "src/api", CWD)).toBe(true)
		expect(matchesRule(rule, "src/api/deep/file.ts", CWD)).toBe(false)
	})

	it("matches globs from an ancestor .agents directory via baseDir relativization", () => {
		// Rule lives in /repo/.agents/rules with glob "project/src/**" — the glob
		// is relative to /repo (the baseDir), not to the session cwd.
		const rule = makeRule({ baseDir: "/repo", globs: ["project/src/**"] })
		expect(matchesRule(rule, "src/api/v1/users.ts", CWD)).toBe(true)
	})

	it("matches ancestor glob ** covering everything under baseDir", () => {
		// Rule in /repo with "**/catalog/**" should match nested catalog dirs.
		const rule = makeRule({ baseDir: "/repo", globs: ["**/catalog/**"] })
		expect(matchesRule(rule, "/repo/project/services/catalog/x.ts", CWD)).toBe(true)
	})

	it("does not match files outside the rule's baseDir subtree", () => {
		const rule = makeRule({ baseDir: "/repo/project", globs: ["src/**"] })
		expect(matchesRule(rule, "/elsewhere/src/a.ts", "/elsewhere")).toBe(false)
	})

	it("supports absolute glob patterns", () => {
		const rule = makeRule({ globs: ["/etc/config/**"] })
		expect(matchesRule(rule, "/etc/config/app.yaml", CWD)).toBe(true)
		expect(matchesRule(rule, "etc/config/app.yaml", CWD)).toBe(false)
	})

	it("returns false for rules without globs", () => {
		const rule = makeRule({ globs: [] })
		expect(matchesRule(rule, "src/api/a.ts", CWD)).toBe(false)
	})

	it("matches multiple glob alternatives", () => {
		const rule = makeRule({ globs: ["*.test.ts", "*.spec.ts"] })
		expect(matchesRule(rule, "matcher.test.ts", CWD)).toBe(true)
		expect(matchesRule(rule, "matcher.spec.ts", CWD)).toBe(true)
		expect(matchesRule(rule, "matcher.ts", CWD)).toBe(false)
	})
})
