/**
 * `disables-skills:` frontmatter support for bundled skills: a *visible*
 * bundled skill may shadow same-named skills from external sources (the
 * Claude Code skills path) while its own `requires-resource` toggle is
 * enabled. The documents skill uses this to suppress the Anthropic office
 * skills (xlsx/pdf/docx/pptx) whose pip/LibreOffice workflows contradict
 * its native read_document guidance.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { collectBundledDisabledSkillNames } from "./resolve-skill-roots.js"

let agentDir: string
let oldAgentDir: string | undefined
let oldEnableResources: string | undefined

beforeEach(() => {
	// Pin the resource-settings path to an empty dir so resource toggles see
	// defaults (documents off) rather than the developer's live settings.json.
	agentDir = mkdtempSync(join(tmpdir(), "kimchi-disables-skills-agent-"))
	oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
	process.env.KIMCHI_CODING_AGENT_DIR = agentDir
	oldEnableResources = process.env.KIMCHI_ENABLE_RESOURCES
	delete process.env.KIMCHI_ENABLE_RESOURCES
})

afterEach(() => {
	if (oldAgentDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
	else process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
	if (oldEnableResources === undefined) delete process.env.KIMCHI_ENABLE_RESOURCES
	else process.env.KIMCHI_ENABLE_RESOURCES = oldEnableResources
})

function makeBundledDir(skills: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-disables-skills-test-"))
	for (const [name, frontmatter] of Object.entries(skills)) {
		mkdirSync(join(dir, name), { recursive: true })
		writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\n${frontmatter}\n---\n# ${name}\n`, "utf-8")
	}
	return dir
}

describe("collectBundledDisabledSkillNames", () => {
	it("collects declared names with their declarer", () => {
		const bundled = makeBundledDir({
			documents: "description: d\ndisables-skills: xlsx, pdf, docx, pptx",
			other: "description: d",
		})
		expect(collectBundledDisabledSkillNames(bundled)).toEqual(
			new Map([
				["xlsx", "documents"],
				["pdf", "documents"],
				["docx", "documents"],
				["pptx", "documents"],
			]),
		)
	})

	/** The resources override file, seeded under the pinned agent dir. */
	function disableSkillPptx(): void {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ resources: { "skills.pptx": false } }))
	}

	it("is inert while the declarer's requires-resource toggle is off", () => {
		disableSkillPptx()
		const bundled = makeBundledDir({
			pptx: "description: d\nrequires-resource: skills.pptx\ndisables-skills: xlsx",
		})
		expect(collectBundledDisabledSkillNames(bundled)).toEqual(new Map())
	})

	it("activates while the declarer's resource toggle is on (skills.pptx defaults on)", () => {
		const bundled = makeBundledDir({
			pptx: "description: d\nrequires-resource: skills.pptx\ndisables-skills: xlsx",
		})
		expect(collectBundledDisabledSkillNames(bundled)).toEqual(new Map([["xlsx", "pptx"]]))
	})

	it("normalizes declared names and drops empty entries", () => {
		const bundled = makeBundledDir({
			documents: "description: d\ndisables-skills: XLSX,  PDF ,",
		})
		expect(collectBundledDisabledSkillNames(bundled)).toEqual(
			new Map([
				["xlsx", "documents"],
				["pdf", "documents"],
			]),
		)
	})

	it("returns an empty map for a missing bundled dir", () => {
		expect(collectBundledDisabledSkillNames("/nonexistent-bundled-skills")).toEqual(new Map())
	})
})
