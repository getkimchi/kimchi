/**
 * `requires-resource:` frontmatter gating for bundled skills: a skill that
 * declares one is advertised only when the resource toggle is enabled, which
 * keeps the advertised skill list identical to master when the experimental
 * toggle is off (rollout rule in the documents plan).
 */

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveSkillRoots } from "./resolve-skill-roots.js"

function makeBundledDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-bundled-skills-test-"))
	mkdirSync(join(dir, "ungated"))
	writeFileSync(join(dir, "ungated", "SKILL.md"), "---\nname: ungated\ndescription: always on\n---\n# U\n")
	mkdirSync(join(dir, "gated"))
	writeFileSync(
		join(dir, "gated", "SKILL.md"),
		"---\nname: gated\ndescription: off by default\nrequires-resource: extensions.documents\n---\n# G\n",
	)
	return dir
}

describe("requires-resource bundled skill gating", () => {
	it("excludes a requires-resource skill when its toggle is off (default)", () => {
		const roots = resolveSkillRoots({ cwd: "/nonexistent-cwd", bundledDir: makeBundledDir() })
		const bundled = roots.find((root) => root.kind === "bundled")
		expect(bundled).toBeDefined()
		expect(readdirSync(bundled!.dir).sort()).toEqual(["ungated"])
	})
})
