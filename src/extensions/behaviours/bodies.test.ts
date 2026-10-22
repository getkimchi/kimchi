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

describe("PR category labels", () => {
	for (const [name, create] of [
		["gh-cli", "gh label list"],
		["glab-cli", "glab mr create --label"],
	] as const) {
		it(`${name} asks for one category label that follows the repo's own labels`, () => {
			const text = body(name)
			expect(text).toContain("add one category label for the task — feature, bug fix, maintenance or exploration")
			expect(text).toContain(create)
			expect(text).toContain("Bug → bug fix, Story/Feature → feature, Task/Chore → maintenance, Spike → exploration")
			expect(text).toContain("If no label fits, don't create one")
		})
	}
})
