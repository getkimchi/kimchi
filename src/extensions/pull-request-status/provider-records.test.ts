import { describe, expect, it } from "vitest"
import { pullRequest } from "./provider-records.js"

describe("provider branch issue keys", () => {
	it("caps distinct keys at 20 in first-appearance order through the public PR parser (K25)", () => {
		const keys = Array.from({ length: 25 }, (_, index) => `ABC-${index + 1}`)
		const parsed = pullRequest(
			{
				id: 1,
				number: 7,
				state: "open",
				html_url: "https://github.com/example/repo/pull/7",
				merged_at: null,
				closed_at: null,
				merge_commit_sha: null,
				head: { sha: "a".repeat(40), ref: keys.join(" ") },
				base: { repo: { id: 42 } },
			},
			{ provider: "github", host: "github.com" },
			"2026-11-24T12:00:00.000Z",
		)

		expect(parsed.branchIssueKeys).toEqual(keys.slice(0, 20))
	})
})
