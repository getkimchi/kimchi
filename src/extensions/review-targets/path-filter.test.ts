import { describe, expect, it } from "vitest"
import { excludeReviewOwnedPaths } from "./path-filter.js"

describe("review-owned path exclusion", () => {
	it("excludes exact directories and descendants but not lookalike paths", () => {
		expect(
			excludeReviewOwnedPaths(
				"/repo",
				["src/a.ts", ".kimchi/review-output/state/panel.json", ".kimchi/review-output-old/file", "src/b.ts"],
				["/repo/.kimchi/review-output"],
			),
		).toEqual(["src/a.ts", ".kimchi/review-output-old/file", "src/b.ts"])
	})
})
