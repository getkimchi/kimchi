import { describe, expect, it } from "vitest"
import { matchesFileHunks } from "./file-hunks.js"

const parent = "heading\none\ntwo\nnative-before\nfour\nfive\nhuman-before\nseven\n"
const after = parent.replace("native-before", "native-after")
const human = (text: string) => text.replace("human-before", "human-after")
const unchangedBudget = () => {}

describe("complete native hunk matching", () => {
	it.each([
		["human edit after", parent, after, parent, human(after)],
		["human edit before", human(parent), human(after), parent, human(after)],
		["shifted lines", parent, after, parent, `prefix\n${human(after)}`],
		[
			"native insertion",
			parent,
			parent.replace("four\n", "added\nfour\n"),
			parent,
			human(parent.replace("four\n", "added\nfour\n")),
		],
		[
			"native deletion",
			parent,
			parent.replace("native-before\n", ""),
			parent,
			human(parent.replace("native-before\n", "")),
		],
		["unrelated trailing newline", parent, after, parent, after.slice(0, -1)],
	])("matches disjoint changes (%s)", (_name, before, result, base, committed) => {
		expect(matchesFileHunks(before, result, base, committed, unchangedBudget)).toBe(true)
	})
	it.each([
		["overlap", parent, after, parent, human(after).replace("native-after", "human-overlap")],
		["already present", parent, after, after, human(after)],
		["partial native patch", parent, after.replace("two", "second-native"), parent, human(after)],
		["adjacent changed context", parent, after, parent, after.replace("four", "human-adjacent")],
		["unstaged newline change", parent, parent.slice(0, -1), parent, human(parent)],
		["canceled change", parent, parent, parent, human(parent)],
	])("leaves incomplete changes unresolved (%s)", (_name, before, result, base, committed) => {
		expect(matchesFileHunks(before, result, base, committed, unchangedBudget)).toBe(false)
	})
	it("rejects repeated context instead of choosing one identical block", () => {
		const before = "same\nx\nsame\nseparator\nsame\nx\nsame\n"
		const result = before.replace("x", "y")
		expect(matchesFileHunks(before, result, before, result, unchangedBudget)).toBe(false)
	})
	it("keeps oversized or expensive diffs unresolved", () => {
		const large = "x".repeat(256 * 1024 + 1)
		expect(matchesFileHunks(large, `${large}changed`, large, `${large}changed`, unchangedBudget)).toBe(false)
		const many = Array.from({ length: 2100 }, (_, index) => `${index}\n`).join("")
		expect(matchesFileHunks(many, many.replaceAll("\n", "changed\n"), many, "new\n", unchangedBudget)).toBe(false)
	})
	it("stops when the owning reconciliation budget expires", () => {
		expect(() =>
			matchesFileHunks(parent, after, parent, human(after), () => {
				throw new Error("deadline")
			}),
		).toThrow("deadline")
	})
})
