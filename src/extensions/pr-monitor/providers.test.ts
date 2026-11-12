import { describe, expect, it } from "vitest"
import { githubChecks, githubFeedback } from "./providers.js"

describe("PR provider normalization", () => {
	it("keeps pending, failed, skipped and external status checks distinct", () => {
		const checks = githubChecks(
			[
				{
					id: 1,
					name: "tests",
					status: "completed",
					conclusion: "failure",
					completed_at: "now",
					output: { summary: "A test failed" },
				},
				{ id: 2, name: "lint", status: "queued", conclusion: null },
				{ id: 3, name: "optional", status: "completed", conclusion: "neutral" },
			],
			[{ id: 4, context: "external", state: "success", target_url: "https://ci.example/job/4" }],
		)
		expect(checks.map((check) => check.state)).toEqual(["failed", "pending", "skipped", "passed"])
		expect(checks[0].summary).toBe("A test failed")
		expect(checks[3].url).toBe("https://ci.example/job/4")
	})

	it("rejects unknown check states instead of showing healthy CI", () => {
		expect(() => githubChecks([{ id: 1, status: "unknown" }], [])).toThrow("unknown CI state")
		expect(() => githubChecks({}, [])).toThrow("invalid PR data")
	})

	it("filters resolved and outdated threads and separates trust from visibility", () => {
		const comment = {
			id: "c",
			body: "Fix the parser",
			url: "https://github.com/o/r/pull/1#discussion_r1",
			updatedAt: "now",
			path: "parser.ts",
			line: 4,
			author: { login: "reviewer" },
			authorAssociation: "MEMBER",
		}
		const feedback = githubFeedback([
			{ id: "resolved", isResolved: true, comments: { nodes: [comment] } },
			{ id: "outdated", isOutdated: true, comments: { nodes: [comment] } },
			{ id: "open", comments: { nodes: [comment] } },
			{ id: "outside", comments: { nodes: [{ ...comment, authorAssociation: "NONE" }] } },
		])
		expect(feedback).toHaveLength(2)
		expect(feedback[0]).toMatchObject({ trusted: true, path: "parser.ts", line: 4 })
		expect(feedback[1].trusted).toBe(false)
	})
})
