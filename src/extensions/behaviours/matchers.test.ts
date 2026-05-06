import { describe, expect, it } from "vitest"
import { bashCommand, bashStartsWith, fetchesHost, webFetchUrl, webSearchQuery } from "./matchers.js"
import type { ToolCallEvent } from "./triggers.js"

function bash(command: string): ToolCallEvent {
	return { toolName: "bash", input: { command } }
}

function webFetch(url: string): ToolCallEvent {
	return { toolName: "web_fetch", input: { url } }
}

function webSearch(query: string): ToolCallEvent {
	return { toolName: "web_search", input: { query } }
}

describe("bashCommand", () => {
	it("matches when the command satisfies the regex", () => {
		const m = bashCommand(/^ls\b/)
		expect(m(bash("ls -la"))).toBe(true)
		expect(m(bash("rm -rf /"))).toBe(false)
	})

	it("matches when the predicate returns true", () => {
		const m = bashCommand((c) => c.includes("danger"))
		expect(m(bash("./danger.sh"))).toBe(true)
		expect(m(bash("./safe.sh"))).toBe(false)
	})

	it("does not match other tools", () => {
		expect(bashCommand(/.*/)(webFetch("https://x"))).toBe(false)
	})
})

describe("bashStartsWith", () => {
	it("matches the bare prefix", () => {
		const m = bashStartsWith("gh")
		expect(m(bash("gh pr list"))).toBe(true)
	})

	it("matches the prefix after a separator", () => {
		const m = bashStartsWith("gh")
		expect(m(bash("cd /tmp && gh pr list"))).toBe(true)
		expect(m(bash("ls; gh pr list"))).toBe(true)
		expect(m(bash("foo || gh pr list"))).toBe(true)
	})

	it("does not match unrelated commands that contain the prefix as a substring", () => {
		const m = bashStartsWith("gh")
		expect(m(bash("git fetch"))).toBe(false)
		expect(m(bash("ghost --help"))).toBe(false)
	})

	it("escapes regex metacharacters in the prefix", () => {
		const m = bashStartsWith("a.b")
		expect(m(bash("a.b run"))).toBe(true)
		expect(m(bash("aXb run"))).toBe(false)
	})
})

describe("webFetchUrl", () => {
	it("matches when the url satisfies the regex", () => {
		const m = webFetchUrl(/github\.com/)
		expect(m(webFetch("https://github.com/owner/repo"))).toBe(true)
		expect(m(webFetch("https://example.com/"))).toBe(false)
	})

	it("does not match other tools", () => {
		expect(webFetchUrl(/.*/)(bash("anything"))).toBe(false)
	})
})

describe("webSearchQuery", () => {
	it("matches by query regex", () => {
		const m = webSearchQuery(/^how to/)
		expect(m(webSearch("how to fix this"))).toBe(true)
		expect(m(webSearch("just stuff"))).toBe(false)
	})
})

describe("fetchesHost", () => {
	it("matches web_fetch against the host", () => {
		const m = fetchesHost("github.com")
		expect(m(webFetch("https://github.com/x/y"))).toBe(true)
		expect(m(webFetch("https://example.com"))).toBe(false)
	})

	it("matches bash curl against the host", () => {
		const m = fetchesHost("github.com")
		expect(m(bash("curl https://api.github.com/repos/x"))).toBe(true)
		expect(m(bash("curl https://example.com"))).toBe(false)
	})

	it("matches bash wget against the host", () => {
		const m = fetchesHost("github.com")
		expect(m(bash("wget https://github.com/x.tar.gz"))).toBe(true)
	})

	it("does not match bash that mentions the host without curl/wget", () => {
		const m = fetchesHost("github.com")
		expect(m(bash("echo github.com"))).toBe(false)
	})

	it("accepts a RegExp host pattern for fuzzier matches", () => {
		const m = fetchesHost(/(api\.)?github\.com/)
		expect(m(webFetch("https://api.github.com/repos"))).toBe(true)
		expect(m(webFetch("https://github.com/x"))).toBe(true)
		expect(m(webFetch("https://gitlab.com/x"))).toBe(false)
	})
})
