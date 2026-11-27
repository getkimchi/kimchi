import { describe, expect, it } from "vitest"
import { REVIEW_LENSES, resolveReviewPanel } from "../review-panel/lenses.js"
import { parseReviewTargetArgs } from "./parser.js"

const defaultPanel = { lenses: [], all: false, concurrency: 2 }

describe("review target parser", () => {
	it("parses every stage 2 invocation with the default panel", () => {
		expect(parseReviewTargetArgs([])).toEqual({ kind: "bare", fetch: false, panel: defaultPanel })
		expect(parseReviewTargetArgs(["--fetch"])).toEqual({ kind: "bare", fetch: true, panel: defaultPanel })
		expect(parseReviewTargetArgs(["working-tree"])).toEqual({ kind: "working-tree", fetch: false, panel: defaultPanel })
		expect(parseReviewTargetArgs(["working-tree", "--fetch"])).toEqual({
			kind: "working-tree",
			fetch: true,
			panel: defaultPanel,
		})
		expect(parseReviewTargetArgs(["branch", "feature", "--base", "origin/main"])).toEqual({
			kind: "branch",
			branch: "feature",
			base: "origin/main",
			includeWorkingTree: false,
			fetch: false,
			panel: defaultPanel,
		})
		expect(
			parseReviewTargetArgs(["branch", "origin/feature", "--fetch", "--include-working-tree", "--base", "origin/main"]),
		).toEqual({
			kind: "branch",
			branch: "origin/feature",
			base: "origin/main",
			includeWorkingTree: true,
			fetch: true,
			panel: defaultPanel,
		})
	})

	it("leaves the base for PR/MR or remote-default suggestion", () => {
		expect(parseReviewTargetArgs(["branch", "feature"])).toMatchObject({ kind: "branch", base: undefined })
	})

	it("selects the default panel and caps slots at the lens count", () => {
		const resolved = resolveReviewPanel(parseReviewTargetArgs([]).panel)
		expect(resolved.lenses.map((lens) => lens.id)).toEqual(["spec", "standards", "operational", "adversarial"])
		expect(resolved.slotCount).toBe(2)
		expect(resolveReviewPanel({ lenses: ["spec"], concurrency: 8 }).slotCount).toBe(1)
	})

	it("activates repeatable --lens with deduplication and shows policy reasons", () => {
		const parsed = parseReviewTargetArgs([
			"working-tree",
			"--lens",
			"security",
			"--lens=spec",
			"--lens",
			"security",
			"--concurrency=1",
		])
		expect(parsed.panel).toEqual({ lenses: ["security", "spec"], all: false, concurrency: 1 })
		const resolved = resolveReviewPanel({
			...parsed.panel,
			requiredLenses: [{ id: "operational", reason: "Organization production policy" }],
		})
		expect(resolved.lenses.map((lens) => lens.id)).toEqual(["spec", "operational", "security"])
		expect(resolved.lenses.find((lens) => lens.id === "operational")?.reasons).toContain(
			"Required by policy: Organization production policy",
		)
		expect(resolved.slotCount).toBe(1)
	})

	it("selects every registered lens with --all", () => {
		const resolved = resolveReviewPanel(parseReviewTargetArgs(["working-tree", "--all", "--concurrency", "3"]).panel)
		expect(resolved.lenses.map((lens) => lens.id)).toEqual(REVIEW_LENSES.map((lens) => lens.id))
		expect(resolved.lenses.map((lens) => lens.id)).toContain("security")
		expect(resolved.slotCount).toBe(3)
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
		[["working-tree", "--lens", "unknown"], "Unknown review lens"],
		[["working-tree", "--lens", "spec", "--all"], "cannot be combined"],
		[["working-tree", "--concurrency", "0"], "positive integer"],
		[["working-tree", "--concurrency", "1.5"], "positive integer"],
		[["working-tree", "--concurrency", "many"], "positive integer"],
		[["working-tree", "--lens"], "requires a value"],
	])("reports invalid invocation %#", (args, message) => {
		expect(() => parseReviewTargetArgs(args)).toThrow(message)
	})
})
