import { describe, expect, it } from "vitest"
import { bashCommand, bashInvokes, fetchesHost, webFetchUrl, webSearchQuery } from "./matchers.js"
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

describe("bashInvokes", () => {
	const m = bashInvokes("gh")

	it("matches the bare invocation", () => {
		expect(m(bash("gh pr list"))).toBe(true)
	})

	it("matches across pipeline / sequence / subshell stages", () => {
		expect(m(bash("cd /tmp && gh pr list"))).toBe(true)
		expect(m(bash("ls; gh pr list"))).toBe(true)
		expect(m(bash("foo || gh pr list"))).toBe(true)
		expect(m(bash("cmd|gh pr list"))).toBe(true)
		expect(m(bash("for x in $(gh pr list); do echo $x; done"))).toBe(true)
		expect(m(bash("(gh pr list)"))).toBe(true)
		expect(m(bash("`gh pr list`"))).toBe(true)
	})

	it("matches after env-var prefixes", () => {
		expect(m(bash("GH_TOKEN=xxx gh pr list"))).toBe(true)
		expect(m(bash("FOO=1 BAR=2 gh pr list"))).toBe(true)
	})

	it("does not match substrings inside string literals", () => {
		expect(m(bash('echo "gh is great"'))).toBe(false)
		expect(m(bash("echo 'gh foo'"))).toBe(false)
		expect(m(bash("echo gh"))).toBe(false)
	})

	it("does not match comments", () => {
		expect(m(bash("ls # gh pr list"))).toBe(false)
	})

	it("does not match unrelated commands sharing a prefix", () => {
		expect(m(bash("git fetch"))).toBe(false)
		expect(m(bash("ghost --help"))).toBe(false)
		expect(m(bash("ghi"))).toBe(false)
	})

	it("does not match heredoc bodies", () => {
		expect(m(bash("cat <<EOF\ngh pr list\nEOF\n"))).toBe(false)
		expect(m(bash("cat <<-END\n\tgh pr list\n\tEND\n"))).toBe(false)
	})

	it("matches bare executable with no args", () => {
		expect(bashInvokes("glab")(bash("glab"))).toBe(true)
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

	it("does not match when curl/wget appears only in a comment", () => {
		const m = fetchesHost("github.com")
		expect(m(bash("ls # curl github.com"))).toBe(false)
	})

	it("does not match when curl is named but not invoked", () => {
		const m = fetchesHost("github.com")
		expect(m(bash("echo curl github.com"))).toBe(false)
	})

	it("does not match curl/wget inside a heredoc body", () => {
		const m = fetchesHost("github.com")
		expect(m(bash("cat <<EOF\ncurl https://github.com\nEOF"))).toBe(false)
	})

	it("matches across pipeline / sequence stages", () => {
		const m = fetchesHost("github.com")
		expect(m(bash("ls && curl https://github.com/x"))).toBe(true)
		expect(m(bash("curl https://github.com/x | jq"))).toBe(true)
	})

	it("accepts a RegExp host pattern for fuzzier matches", () => {
		const m = fetchesHost(/(api\.)?github\.com/)
		expect(m(webFetch("https://api.github.com/repos"))).toBe(true)
		expect(m(webFetch("https://github.com/x"))).toBe(true)
		expect(m(webFetch("https://gitlab.com/x"))).toBe(false)
	})
})
