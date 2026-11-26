/**
 * The PR and MR bodies ask the agent to label each new PR/MR with one category, so PR costs can later be split into
 * features, bug fixes, maintenance and exploration. The bodies are read from disk: vitest cannot load Bun's
 * markdown text imports (see build.test.ts).
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

function body(name: string): string {
	return readFileSync(new URL(`./bodies/${name}.md`, import.meta.url), "utf8")
}

describe("finish-line-verification checks final source and external contracts", () => {
	const text = body("finish-line-verification")

	it("requires complete source, post-edit validation, direct contract checks, and test preservation", () => {
		expect(text).toContain("Inspect the complete final diff, including new and untracked files")
		expect(text).toContain("After the last substantive edit, run the most relevant existing build and test commands")
		expect(text).toContain("Check public APIs and configuration directly")
		expect(text).toContain("test the interpretation the implementation currently rejects")
		expect(text).toContain("Do not modify existing tests solely for validation")
	})

	it("does not introduce clean-checkout replay or a second reviewer", () => {
		expect(text).not.toMatch(/clean(?: |-)?checkout|second reviewer|reviewer subagent/i)
	})
})

describe("PR category labels", () => {
	for (const [name, create] of [
		["gh-cli", "gh label list"],
		["glab-cli", "glab mr create --label"],
	] as const) {
		it(`${name} asks for one category label that follows the repo's own labels`, () => {
			const text = body(name)
			expect(text).toContain("add one category label for the task — feature, bug fix, maintenance or exploration")
			expect(text).toContain(create)
			expect(text).toContain("Bug → bug fix, Story/Feature → feature, Chore → maintenance, Spike → exploration")
			// Jira's default Task is often feature work, and the Kimchi reviewer keeps a label the agent already set.
			expect(text).toContain("judge a plain Task, or work with no issue, by what the change does")
			expect(text).toContain("If no label fits, don't create one")
		})
	}
})
