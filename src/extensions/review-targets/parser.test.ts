import { describe, expect, it } from "vitest"
import { parseReviewTargetArgs } from "./parser.js"

describe("review target parser", () => {
	it("parses every stage 2 invocation", () => {
		expect(parseReviewTargetArgs([])).toEqual({ kind: "bare", fetch: false })
		expect(parseReviewTargetArgs(["--fetch"])).toEqual({ kind: "bare", fetch: true })
		expect(parseReviewTargetArgs(["working-tree"])).toEqual({ kind: "working-tree", fetch: false })
		expect(parseReviewTargetArgs(["working-tree", "--fetch"])).toEqual({ kind: "working-tree", fetch: true })
		expect(parseReviewTargetArgs(["branch", "feature", "--base", "origin/main"])).toEqual({
			kind: "branch",
			branch: "feature",
			base: "origin/main",
			includeWorkingTree: false,
			fetch: false,
		})
		expect(
			parseReviewTargetArgs(["branch", "origin/feature", "--fetch", "--include-working-tree", "--base", "origin/main"]),
		).toEqual({
			kind: "branch",
			branch: "origin/feature",
			base: "origin/main",
			includeWorkingTree: true,
			fetch: true,
		})
	})

	it("leaves the base for PR/MR or remote-default suggestion", () => {
		expect(parseReviewTargetArgs(["branch", "feature"])).toMatchObject({ kind: "branch", base: undefined })
	})

	it.each([
		[["working-tree", "--unknown"], "Unknown review target option"],
		[["working-tree", "--base", "main"], "can only be used with a branch target"],
		[["working-tree", "--include-working-tree"], "can only be used with a branch target"],
		[["branch"], "branch requires a ref"],
		[["branch", "--base", "main"], "branch requires a ref"],
		[["branch", "feature", "--base"], "requires a ref value"],
		[["branch", "feature", "--base", "--fetch"], "requires a ref value"],
		[["branch", "feature", "--base", "main", "--base", "other"], "more than once"],
		[["branch", "feature", "extra"], "Unexpected positional argument"],
		[["other"], "Unknown review target"],
		[["--base", "main"], "requires an explicit working-tree or branch target"],
	])("reports invalid invocation %#", (args, message) => {
		expect(() => parseReviewTargetArgs(args)).toThrow(message)
	})

	it.each(["--lens", "--all", "--concurrency"])("reserves %s for panel parsing without implementing it", (option) => {
		expect(() => parseReviewTargetArgs(["working-tree", option])).toThrow("reserved for panel selection")
	})
})
