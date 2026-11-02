import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../../../project-scope-trust.js"
import { matchBriefSkills } from "./brief-skill-loader.js"

// The project-scope gate is module-global state; reset it after each test so
// a trusted decision cannot leak into sibling tests.
afterEach(resetProjectScopeTrustForTests)

const skillMd = (frontmatter: string, body = "skill body"): string => `---\n${frontmatter}\n---\n\n${body}\n`

function writeSkill(base: string, name: string, content: string, usage?: object): void {
	const dir = join(base, name)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "SKILL.md"), content)
	if (usage) writeFileSync(join(dir, ".usage.json"), JSON.stringify(usage))
}

function makeTree(): { home: string; cwd: string } {
	const base = mkdtempSync(join(tmpdir(), "kimchi-brief-"))
	const home = join(base, "home")
	const cwd = join(base, "project")
	mkdirSync(join(home, ".config", "kimchi", "harness", "skills"), { recursive: true })
	mkdirSync(cwd, { recursive: true })
	return { home, cwd }
}

const harnessSkills = (home: string): string => join(home, ".config", "kimchi", "harness", "skills")
const projectSkills = (cwd: string): string => join(cwd, ".kimchi", "skills")
const configSkills = (cwd: string): string => join(cwd, ".pi", "agent", "skills")

const opts = (home: string, isResourceEnabled?: (id: string) => boolean) => ({
	homeDir: home,
	bundledDir: null as string | null,
	...(isResourceEnabled ? { isResourceEnabled } : {}),
})

describe("matchBriefSkills", () => {
	it("matches an extension trigger from a harness skill", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: pdf\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		const matched = await matchBriefSkills("analyze the report.pdf file", cwd, opts(home))
		expect(matched).toHaveLength(1)
		expect(matched[0]?.name).toBe("pdf")
		expect(matched[0]?.matched).toBe("ext:.pdf")
		expect(matched[0]?.content).toContain("skill body")
	})

	it("matches a keyword trigger", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pptx",
			skillMd("name: pptx\ndescription: p\ntriggers:\n  prompt:\n    keywords: [powerpoint]"),
		)
		const matched = await matchBriefSkills("build a PowerPoint deck", cwd, opts(home))
		expect(matched.map((m) => m.name)).toEqual(["pptx"])
		expect(matched[0]?.matched).toBe("kw:powerpoint")
	})

	it("returns no matches when nothing matches", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		expect(await matchBriefSkills("summarize this text", cwd, opts(home))).toEqual([])
	})

	it("returns no matches for an empty or whitespace brief", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		expect(await matchBriefSkills("", cwd, opts(home))).toEqual([])
		expect(await matchBriefSkills("   \n\t ", cwd, opts(home))).toEqual([])
	})

	it("caps matches at 2 in tier order (project > config > harness)", async () => {
		const { home, cwd } = makeTree()
		const fm = (name: string) => skillMd(`name: ${name}\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]`)
		writeSkill(projectSkills(cwd), "p-skill", fm("p-skill"))
		writeSkill(configSkills(cwd), "c-skill", fm("c-skill"))
		writeSkill(harnessSkills(home), "h-skill", fm("h-skill"))
		setProjectScopeTrusted(cwd, true)
		const matched = await matchBriefSkills("read report.pdf today", cwd, opts(home))
		expect(matched.map((m) => m.name)).toEqual(["p-skill", "c-skill"])
	})

	it("never auto-loads an agent_created harness skill (sidecar flag)", async () => {
		const { home, cwd } = makeTree()
		const fm = skillMd("name: pdf\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]")
		writeSkill(harnessSkills(home), "pdf", fm, { agent_created: true })
		expect(await matchBriefSkills("read report.pdf", cwd, opts(home))).toEqual([])

		writeSkill(harnessSkills(home), "pdf", fm, { agent_created: false })
		const matched = await matchBriefSkills("read report.pdf", cwd, opts(home))
		expect(matched.map((m) => m.name)).toEqual(["pdf"])
	})

	it("skips disable-model-invocation skills", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: p\ndisable-model-invocation: true\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		expect(await matchBriefSkills("read report.pdf", cwd, opts(home))).toEqual([])
	})

	it("gates requires-resource skills on the resource toggle", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: p\nrequires-resource: skills.pdf\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		expect(
			await matchBriefSkills(
				"read report.pdf",
				cwd,
				opts(home, () => false),
			),
		).toEqual([])
		const matched = await matchBriefSkills(
			"read report.pdf",
			cwd,
			opts(home, (id) => id === "skills.pdf"),
		)
		expect(matched.map((m) => m.name)).toEqual(["pdf"])
	})

	it("skips untrusted project roots", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			projectSkills(cwd),
			"evil",
			skillMd("name: evil\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		setProjectScopeTrusted(cwd, false)
		expect(await matchBriefSkills("read report.pdf", cwd, opts(home))).toEqual([])
	})

	it("lets a stronger tier shadow a same-name weaker skill", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			projectSkills(cwd),
			"dup",
			skillMd("name: dup\ndescription: p\ntriggers:\n  prompt:\n    keywords: [alpha]"),
		)
		writeSkill(
			harnessSkills(home),
			"dup",
			skillMd("name: dup\ndescription: p\ntriggers:\n  prompt:\n    keywords: [beta]"),
		)
		setProjectScopeTrusted(cwd, true)
		const matched = await matchBriefSkills("alpha beta here", cwd, opts(home))
		expect(matched).toHaveLength(1)
		expect(matched[0]?.name).toBe("dup")
		expect(matched[0]?.matched).toBe("kw:alpha")
	})

	it("carries a provenance label for non-bundled tiers", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			projectSkills(cwd),
			"proj",
			skillMd("name: proj\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		setProjectScopeTrusted(cwd, true)
		const [matched] = await matchBriefSkills("read report.pdf", cwd, opts(home))
		expect(matched?.label).toBe("a project skill")
	})

	it("degrades to no matches when the scan fails", async () => {
		const { home, cwd } = makeTree()
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const matched = await matchBriefSkills("read report.pdf", join(cwd, "does-not-matter"), {
			homeDir: home,
			bundledDir: null,
			// Force a throw inside the scan: a broken resource probe surfaces as
			// a rejected gate check per skill, but a throwing resolver path is
			// simulated via an invalid home that makes root resolution fail.
			isResourceEnabled: () => {
				throw new Error("boom")
			},
		})
		expect(matched).toEqual([])
		warn.mockRestore()
	})
})

describe("renderBriefSkillBlock", () => {
	it("renders the auto-load note, provenance, and body", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		const [matched] = await matchBriefSkills("read report.pdf", cwd, opts(home))
		const block = matched ? await import("./brief-skill-loader.js").then((m) => m.renderBriefSkillBlock(matched)) : ""
		expect(block).toContain("do not call skill_view for it")
		expect(block).toContain("a user skill in your harness skills directory")
		expect(block).toContain("ext:.pdf")
		expect(block).toContain("skill body")
	})

	it("omits the provenance sentence for bundled skills", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			projectSkills(cwd),
			"proj",
			skillMd("name: proj\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		setProjectScopeTrusted(cwd, true)
		const [matched] = await matchBriefSkills("read report.pdf", cwd, opts(home))
		const block = matched ? await import("./brief-skill-loader.js").then((m) => m.renderBriefSkillBlock(matched)) : ""
		expect(block).toContain("a project skill")
	})
})
