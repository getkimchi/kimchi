import { describe, expect, it } from "vitest"
import { evaluateRules, matchBashRule, matchPathRule, matchRule, parseRule, stringifyRule } from "./rules.js"
import type { Rule } from "./types.js"

describe("parseRule", () => {
	it("parses a bare tool name", () => {
		const r = parseRule("Bash", "allow", "user")
		expect(r).toEqual({ toolName: "bash", content: undefined, behavior: "allow", source: "user" })
	})

	it("parses a tool + content rule", () => {
		const r = parseRule("Bash(git status)", "allow", "session")
		expect(r).toEqual({ toolName: "bash", content: "git status", behavior: "allow", source: "session" })
	})

	it("lowercases tool names", () => {
		const r = parseRule("WRITE(.env)", "deny", "user")
		expect(r?.toolName).toBe("write")
	})

	it("preserves mcp__ tool names", () => {
		const r = parseRule("mcp__castai_prod_eu__list_clusters", "allow", "user")
		expect(r?.toolName).toBe("mcp__castai_prod_eu__list_clusters")
	})

	it("rejects malformed rules", () => {
		expect(parseRule("", "allow", "user")).toBeNull()
		expect(parseRule("   ", "allow", "user")).toBeNull()
		expect(parseRule("Bash(unterminated", "allow", "user")).toBeNull()
	})

	it("stringifies to lowercase internal name", () => {
		const r = parseRule("Bash(git status)", "allow", "user")
		expect(r).not.toBeNull()
		expect(stringifyRule(r as Rule)).toBe("bash(git status)")
	})
})

describe("matchBashRule", () => {
	it("exact match", () => {
		expect(matchBashRule("git status", "git status")).toBe(true)
		expect(matchBashRule("git status", "git status -s")).toBe(false)
	})

	it("legacy prefix :*", () => {
		expect(matchBashRule("git:*", "git status")).toBe(true)
		expect(matchBashRule("git:*", "git log --oneline")).toBe(true)
		expect(matchBashRule("git:*", "git")).toBe(true)
		expect(matchBashRule("git:*", "github-cli")).toBe(false)
	})

	it("wildcard *", () => {
		expect(matchBashRule("npm test *", "npm test foo")).toBe(true)
		expect(matchBashRule("npm test *", "npm test")).toBe(true) // trailing ' *' optional
		expect(matchBashRule("npm test *", "npm build")).toBe(false)
	})

	it("literal * via escape", () => {
		expect(matchBashRule("echo \\*", "echo *")).toBe(true)
		expect(matchBashRule("echo \\*", "echo foo")).toBe(false)
	})

	it("anchored matching", () => {
		expect(matchBashRule("git status", "git status  ")).toBe(true) // cmd is trimmed
		expect(matchBashRule("status", "git status")).toBe(false)
	})
})

describe("matchPathRule", () => {
	it("exact path", () => {
		expect(matchPathRule(".env", ".env")).toBe(true)
		expect(matchPathRule(".env", ".envrc")).toBe(false)
	})

	it("glob with dots", () => {
		expect(matchPathRule("**/.env*", "src/.env.test")).toBe(true)
		expect(matchPathRule("src/**", "src/cli.ts")).toBe(true)
		expect(matchPathRule("src/**", "tests/foo.ts")).toBe(false)
	})

	it("empty path never matches", () => {
		expect(matchPathRule("**", "")).toBe(false)
	})
})

describe("matchRule", () => {
	const bashRule = parseRule("Bash(git:*)", "allow", "user") as Rule
	const writeRule = parseRule("Write(src/**)", "deny", "user") as Rule
	const anyRule = parseRule("Bash", "deny", "user") as Rule

	it("bash rule matches by command", () => {
		expect(matchRule(bashRule, "bash", { command: "git status" })).toBe(true)
		expect(matchRule(bashRule, "bash", { command: "npm test" })).toBe(false)
	})

	it("write rule matches by path", () => {
		expect(matchRule(writeRule, "write", { path: "src/cli.ts" })).toBe(true)
		expect(matchRule(writeRule, "write", { path: "README.md" })).toBe(false)
	})

	it("content-less rule matches any invocation", () => {
		expect(matchRule(anyRule, "bash", { command: "anything" })).toBe(true)
		expect(matchRule(anyRule, "read", { path: "foo" })).toBe(false) // wrong tool
	})
})

describe("evaluateRules precedence", () => {
	const rules: Rule[] = [
		{ toolName: "bash", content: "git status", behavior: "allow", source: "user" },
		{ toolName: "bash", content: "git:*", behavior: "deny", source: "project" },
		{ toolName: "bash", content: "git status", behavior: "allow", source: "session" },
	]

	it("session beats project and user", () => {
		const match = evaluateRules(rules, "bash", { command: "git status" })
		expect(match.decision).toBe("allow")
		if (match.decision !== "no-match") expect(match.rule.source).toBe("session")
	})

	it("deny beats allow within same source", () => {
		const r: Rule[] = [
			{ toolName: "bash", content: "git:*", behavior: "allow", source: "user" },
			{ toolName: "bash", content: "git push:*", behavior: "deny", source: "user" },
		]
		const match = evaluateRules(r, "bash", { command: "git push origin" })
		expect(match.decision).toBe("deny")
	})

	it("falls through when no rule matches", () => {
		const match = evaluateRules(rules, "bash", { command: "rm -rf" })
		expect(match.decision).toBe("no-match")
	})

	it("auto-rewrites bare rules to match bash invocations of that program", () => {
		const r: Rule[] = [{ toolName: "rm", content: undefined, behavior: "deny", source: "project" }]
		expect(evaluateRules(r, "bash", { command: "rm file.txt" }).decision).toBe("deny")
		expect(evaluateRules(r, "bash", { command: "rtk rm file.txt" }).decision).toBe("deny")
		expect(evaluateRules(r, "bash", { command: "mv file.txt" }).decision).toBe("no-match")
		// When rtk wraps "bash", the underlying program is "bash", not "rm".
		expect(evaluateRules(r, "bash", { command: "rtk bash rm file.txt" }).decision).toBe("no-match")
	})

	it("auto-rewrite affects bash builtins that share tool names", () => {
		const r: Rule[] = [{ toolName: "read", content: undefined, behavior: "deny", source: "project" }]
		expect(evaluateRules(r, "read", { path: "foo" }).decision).toBe("deny")
		// read is also a bash builtin, so bare "read" rule matches bash(read ...)
		expect(evaluateRules(r, "bash", { command: "read var" }).decision).toBe("deny")
		expect(evaluateRules(r, "bash", { command: "echo hello" }).decision).toBe("no-match")
	})

	it("first match in source order wins across sources", () => {
		const r: Rule[] = [
			{ toolName: "bash", content: undefined, behavior: "allow", source: "project" },
			{ toolName: "bash", content: undefined, behavior: "deny", source: "local" },
		]
		// local has higher precedence than project.
		const match = evaluateRules(r, "bash", { command: "anything" })
		expect(match.decision).toBe("deny")
	})
})
