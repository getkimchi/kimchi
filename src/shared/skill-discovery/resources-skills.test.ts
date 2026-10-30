/**
 * Every directory under resources/skills/ is a bundled skill: it must contain
 * a SKILL.md whose frontmatter passes the repo's validator (name matches the
 * folder, description present). Also pins the gh-cli/glab-cli separation:
 * their guidance lives in behaviour bodies (src/extensions/behaviours/), NOT
 * in bundled skills — the skills catalog is not a second home for them.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
	buildTriggerRegistry,
	matchPrompt,
	parseSkillTriggers,
} from "../../extensions/skills-manager/skill-triggers.js"
import { validateSkill } from "./validate-skill.js"

const SKILLS_ROOT = fileURLToPath(new URL("../../../resources/skills", import.meta.url))

function skillDirs(): string[] {
	return readdirSync(SKILLS_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
}

describe("bundled resources/skills", () => {
	it("contains at least one skill", () => {
		expect(skillDirs().length).toBeGreaterThan(0)
	})

	it.each(skillDirs())("%s has a valid SKILL.md", (dir) => {
		const skillFile = join(SKILLS_ROOT, dir, "SKILL.md")
		expect(existsSync(skillFile), `${dir} is missing SKILL.md`).toBe(true)
		expect(() => validateSkill(skillFile)).not.toThrow()
	})

	it("keeps gh/glab guidance out of the bundled skills (they are behaviours)", () => {
		const dirs = skillDirs()
		expect(dirs).not.toContain("gh-cli")
		expect(dirs).not.toContain("glab-cli")
	})

	// Deterministic auto-load contract: document skills declare the
	// extensions/keywords grammar that hits their own file types and words,
	// and rejects the others'. `extensions` matches file names only; bare
	// extension words ("make it a docx") must be listed in `keywords`.
	const DOCUMENT_TRIGGERS: Record<
		string,
		{ extensions: string[]; keywords: string[]; matches: string[]; rejects: string[] }
	> = {
		pdf: {
			extensions: ["pdf"],
			keywords: ["pdf"],
			matches: [
				"runbook.pdf",
				"~/q4-mail-migration/mail-migration-runbook-q4-hard.pdf",
				"convert it to PDF",
				"summarize the attached pdf",
			],
			rejects: ["notes.docx", "pdftk"],
		},
		docx: {
			extensions: ["docx"],
			keywords: ["docx", "word document", "word doc", "microsoft word"],
			matches: ["letter.docx", "export it as a docx", "edit the Word document", "open the Microsoft Word file"],
			rejects: ["slides.pptx", "a.pdf"],
		},
		xlsx: {
			extensions: ["xlsx", "xlsm"],
			keywords: ["xlsx", "xlsm", "spreadsheet", "excel", "workbook"],
			matches: [
				"data.xlsx",
				"book.xlsm",
				"what's in this spreadsheet",
				"open the Excel file",
				"fill the workbook",
				"save as xlsx",
			],
			rejects: ["a.pdf", "data.csv", "spreadsheeting"],
		},
		pptx: {
			extensions: ["pptx"],
			keywords: [
				"pptx",
				"ppt",
				"powerpoint",
				"power point",
				"slide deck",
				"pitch deck",
				"slide presentation",
				"slides",
			],
			matches: [
				"deck.pptx",
				"make a PowerPoint",
				"export as ppt",
				"summarize the slide deck",
				"the pitch deck",
				"edit the slide presentation",
				"add two slides",
			],
			rejects: ["a.pdf", "slide animation"],
		},
	}

	it.each(Object.keys(DOCUMENT_TRIGGERS))("%s declares working prompt triggers", (name) => {
		const content = readFileSync(join(SKILLS_ROOT, name, "SKILL.md"), "utf-8")
		const { extensions, keywords } = parseSkillTriggers(content)
		const spec = DOCUMENT_TRIGGERS[name]
		expect(extensions, `${name} extensions`).toEqual(spec.extensions)
		expect(keywords, `${name} keywords`).toEqual(spec.keywords)
		const registry = buildTriggerRegistry([{ name, content, origin: "bundled" }])
		expect(registry.has(name), `${name} must declare at least one trigger`).toBe(true)
		for (const sample of spec.matches) {
			expect(matchPrompt(registry, sample), `${name} should match '${sample}'`).toHaveLength(1)
		}
		for (const sample of spec.rejects) {
			expect(matchPrompt(registry, sample), `${name} should not match '${sample}'`).toHaveLength(0)
		}
	})
})
