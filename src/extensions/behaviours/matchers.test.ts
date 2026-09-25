import { describe, expect, it } from "vitest"
import { bashCommand, webFetchUrl, webSearchQuery } from "./matchers.js"
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
