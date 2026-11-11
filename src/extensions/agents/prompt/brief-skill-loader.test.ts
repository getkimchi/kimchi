import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../../../project-scope-trust.js"
import { renderBriefSkillBlock, sanitizeLine, scanBriefSkills } from "./brief-skill-loader.js"

// The project-scope gate is module-global state; reset it after each test so
// a trusted decision cannot leak into sibling tests.
afterEach(resetProjectScopeTrustForTests)

// Per-test escape hatches for fault injection (see the failure-path tests).
const resolverState = vi.hoisted(() => ({ throwOnScan: false }))
const fsState = vi.hoisted(() => ({ failSkillReads: false }))

vi.mock("../../../shared/skill-discovery/resolve-skill-roots.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../shared/skill-discovery/resolve-skill-roots.js")>()
	return {
		...actual,
		resolveSkillRoots: (...args: Parameters<typeof actual.resolveSkillRoots>) => {
			if (resolverState.throwOnScan) throw new Error("resolver boom")
			return actual.resolveSkillRoots(...args)
		},
	}
})

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return {
		...actual,
		readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
			if (fsState.failSkillReads && String(path).endsWith("SKILL.md")) {
				throw new Error("EACCES: simulated unreadable skill body")
			}
			return (actual.readFileSync as (...a: unknown[]) => string)(path, ...rest)
		},
	}
})

afterEach(() => {
	resolverState.throwOnScan = false
	fsState.failSkillReads = false
})

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
const bundledSkills = (base: string): string => join(base, "bundled-skills")

const opts = (home: string, isResourceEnabled?: (id: string) => boolean) => ({
	homeDir: home,
	bundledDir: null as string | null,
	...(isResourceEnabled ? { isResourceEnabled } : {}),
})

describe("scanBriefSkills", () => {
	it("matches an extension trigger from a harness skill", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: pdf\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		const { matched } = await scanBriefSkills("analyze the report.pdf file", cwd, opts(home))
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
		const { matched } = await scanBriefSkills("build a PowerPoint deck", cwd, opts(home))
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
		const scan = await scanBriefSkills("summarize this text", cwd, opts(home))
		expect(scan.matched).toEqual([])
		// The metadata list is still produced for the Available Skills block.
		expect(scan.available.map((s) => s.name)).toEqual(["pdf"])
	})

	it("matches nothing for an empty or whitespace brief but still lists skills", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		const empty = await scanBriefSkills("", cwd, opts(home))
		expect(empty.matched).toEqual([])
		expect(empty.available.map((s) => s.name)).toEqual(["pdf"])
		const blank = await scanBriefSkills("   \n\t ", cwd, opts(home))
		expect(blank.matched).toEqual([])
	})

	it("skips brief matching entirely when matchBrief is off (metadata list still produced)", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		const scan = await scanBriefSkills("read report.pdf", cwd, { ...opts(home), matchBrief: false })
		expect(scan.matched).toEqual([])
		expect(scan.available.map((s) => s.name)).toEqual(["pdf"])
	})

	it("caps matches at 2 in tier order (project > config > harness)", async () => {
		const { home, cwd } = makeTree()
		const fm = (name: string) => skillMd(`name: ${name}\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]`)
		writeSkill(projectSkills(cwd), "p-skill", fm("p-skill"))
		writeSkill(configSkills(cwd), "c-skill", fm("c-skill"))
		writeSkill(harnessSkills(home), "h-skill", fm("h-skill"))
		setProjectScopeTrusted(cwd, true)
		const { matched } = await scanBriefSkills("read report.pdf today", cwd, opts(home))
		expect(matched.map((m) => m.name)).toEqual(["p-skill", "c-skill"])
	})

	it("never auto-loads an agent_created harness skill (sidecar flag)", async () => {
		const { home, cwd } = makeTree()
		const fm = skillMd("name: pdf\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]")
		writeSkill(harnessSkills(home), "pdf", fm, { agent_created: true })
		expect((await scanBriefSkills("read report.pdf", cwd, opts(home))).matched).toEqual([])

		writeSkill(harnessSkills(home), "pdf", fm, { agent_created: false })
		const { matched } = await scanBriefSkills("read report.pdf", cwd, opts(home))
		expect(matched.map((m) => m.name)).toEqual(["pdf"])
	})

	it("skips disable-model-invocation skills", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: p\ndisable-model-invocation: true\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		expect((await scanBriefSkills("read report.pdf", cwd, opts(home))).matched).toEqual([])
	})

	it("gates requires-resource skills on the resource toggle", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: p\nrequires-resource: skills.pdf\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		// Toggle off: not advertised, not preloaded (parent-catalog parity).
		expect(
			(
				await scanBriefSkills(
					"read report.pdf",
					cwd,
					opts(home, () => false),
				)
			).available,
		).toEqual([])
		expect(
			(
				await scanBriefSkills(
					"read report.pdf",
					cwd,
					opts(home, () => false),
				)
			).matched,
		).toEqual([])
		const { matched } = await scanBriefSkills(
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
		const scan = await scanBriefSkills("read report.pdf", cwd, opts(home))
		expect(scan.matched).toEqual([])
		expect(scan.available).toEqual([])
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
		const { matched } = await scanBriefSkills("alpha beta here", cwd, opts(home))
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
		const { matched } = await scanBriefSkills("read report.pdf", cwd, opts(home))
		expect(matched[0]?.label).toBe("a project skill")
	})

	it("carries no provenance label for the bundled tier", async () => {
		const { home, cwd } = makeTree()
		const bundled = bundledSkills(join(cwd, ".."))
		writeSkill(
			bundled,
			"bundled-pdf",
			skillMd("name: bundled-pdf\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		const { matched } = await scanBriefSkills("read report.pdf", cwd, { ...opts(home), bundledDir: bundled })
		expect(matched.map((m) => m.name)).toEqual(["bundled-pdf"])
		expect(matched[0]?.label).toBeUndefined()
	})

	it("excludes disables-skills-shadowed names from discovered roots only", async () => {
		const { home, cwd } = makeTree()
		const bundled = bundledSkills(join(cwd, ".."))
		writeSkill(bundled, "documents", skillMd("name: documents\ndescription: d\ndisables-skills: evil"))
		writeSkill(
			projectSkills(cwd),
			"evil",
			skillMd("name: evil\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		writeSkill(
			harnessSkills(home),
			"evil",
			skillMd("name: evil\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		setProjectScopeTrusted(cwd, true)
		const scan = await scanBriefSkills("read report.pdf", cwd, { ...opts(home), bundledDir: bundled })
		// The project (discovered) evil is shadowed by the bundled declarer;
		// the harness (native) evil is not. The bundled declarer itself is
		// listed (bundled roots are never shadowed).
		expect(scan.available.map((s) => s.name)).toEqual(["evil", "documents"])
		expect(scan.matched.map((m) => m.name)).toEqual(["evil"])
		expect(scan.matched[0]?.label).toBe("a user skill in your harness skills directory")
	})

	it("sanitizes hostile skill names to a single prompt-safe line", () => {
		expect(sanitizeLine("bad\nname")).toBe("bad name")
		expect(sanitizeLine("  spaced\tout  ")).toBe("spaced out")
		expect(sanitizeLine("ctl\u0000x\u001f")).toBe("ctl x")
		expect(sanitizeLine("x".repeat(500))).toHaveLength(200)
	})

	it("keeps an unreadable skill in the metadata list but out of the preload set, with a warn", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		fsState.failSkillReads = true
		const scan = await scanBriefSkills("read report.pdf", cwd, opts(home))
		warn.mockRestore()
		expect(scan.available.map((s) => s.name)).toEqual(["pdf"])
		expect(scan.matched).toEqual([])
	})

	it("degrades to empty results when the root scan fails, with a warn", async () => {
		const { home, cwd } = makeTree()
		writeSkill(
			harnessSkills(home),
			"pdf",
			skillMd("name: pdf\ndescription: p\ntriggers:\n  prompt:\n    extensions: [pdf]"),
		)
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		resolverState.throwOnScan = true
		const scan = await scanBriefSkills("read report.pdf", cwd, opts(home))
		// Assert before mockRestore(): restoring clears the recorded calls.
		expect(warn).toHaveBeenCalledWith("[skill-autoload] subagent brief scan failed:", expect.any(Error))
		warn.mockRestore()
		expect(scan).toEqual({ available: [], matched: [] })
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
		const { matched } = await scanBriefSkills("read report.pdf", cwd, opts(home))
		const block = matched[0] ? renderBriefSkillBlock(matched[0]) : ""
		expect(block).toContain("do not call skill_view for it")
		expect(block).toContain("a user skill in your harness skills directory")
		expect(block).toContain("ext:.pdf")
		expect(block).toContain("skill body")
		// Same shape as the parent's skill_view result: the skill directory is
		// included so linked files stay reachable without a skill_view call.
		expect(block).toContain("Skill directory: ")
	})
})
