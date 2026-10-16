/**
 * `requires-resource:` frontmatter gating for bundled skills: a skill that
 * declares one is advertised only while that resource toggle is enabled.
 * `skills.pptx` is enabled by default, so gating off needs an explicit
 * settings override — which is also how a user turns the skill off.
 */

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveSkillRoots } from "./resolve-skill-roots.js"

let agentDir: string
let oldAgentDir: string | undefined

beforeEach(() => {
	// Pin the resource-settings path to an empty dir so the gating-under-test
	// sees toggle defaults rather than the developer's live settings.json.
	agentDir = mkdtempSync(join(tmpdir(), "kimchi-requires-resource-agent-"))
	oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
	process.env.KIMCHI_CODING_AGENT_DIR = agentDir
})

afterEach(() => {
	if (oldAgentDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
	else process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
})

function makeBundledDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-bundled-skills-test-"))
	mkdirSync(join(dir, "ungated"))
	writeFileSync(join(dir, "ungated", "SKILL.md"), "---\nname: ungated\ndescription: always on\n---\n# U\n")
	mkdirSync(join(dir, "gated"))
	writeFileSync(
		join(dir, "gated", "SKILL.md"),
		"---\nname: gated\ndescription: behind skills.pptx\nrequires-resource: skills.pptx\n---\n# G\n",
	)
	return dir
}

describe("requires-resource bundled skill gating", () => {
	it("includes a requires-resource skill while its toggle is on (skills.pptx defaults on)", () => {
		const roots = resolveSkillRoots({ cwd: "/nonexistent-cwd", bundledDir: makeBundledDir() })
		const bundled = roots.find((root) => root.kind === "bundled")
		expect(bundled?.dir).toBeDefined()
		expect(readdirSync(bundled?.dir ?? "").sort()).toEqual(["gated", "ungated"])
	})

	it("excludes a requires-resource skill when its toggle is disabled in settings", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ resources: { "skills.pptx": false } }))
		const roots = resolveSkillRoots({ cwd: "/nonexistent-cwd", bundledDir: makeBundledDir() })
		const bundled = roots.find((root) => root.kind === "bundled")
		expect(bundled?.dir).toBeDefined()
		expect(readdirSync(bundled?.dir ?? "").sort()).toEqual(["ungated"])
	})
})
