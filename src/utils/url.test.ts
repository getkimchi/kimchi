// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { describe, expect, it } from "vitest"
import { plainURL } from "./url.js"

describe("plainURL", () => {
	it("accepts a plain HTTPS URL", () => {
		expect(plainURL("https://github.com/team/repo/pull/1")?.host).toBe("github.com")
	})
	it.each([
		"https://user:secret@github.com/team/repo",
		"https://github.com/team/repo?token=secret",
		"https://github.com/team/repo#fragment",
		"http://github.com/team/repo",
		"not a url",
		42,
	])("rejects %j", (value) => {
		expect(plainURL(value)).toBeUndefined()
	})
	it("accepts another listed protocol", () => {
		expect(plainURL("http://localhost:8080/api", ["https:", "http:"])?.port).toBe("8080")
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
