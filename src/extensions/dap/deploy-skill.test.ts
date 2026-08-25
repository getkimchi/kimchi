import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { deployDapSkill, resolveSkillSourceDir } from "./deploy-skill.js"

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "skill")

const files = [
	"SKILL.md",
	"references/go.md",
	"references/python.md",
	"references/typescript.md",
	"references/native.md",
]
const sourceContent = (rel: string) => readFileSync(join(SOURCE_DIR, rel), "utf-8")

describe("resolveSkillSourceDir", () => {
	it("resolves the in-repo skill directory when running from source", () => {
		expect(resolveSkillSourceDir()).toBe(SOURCE_DIR)
	})
})

describe("deployDapSkill", () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dap-skill-deploy-"))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it("deploys SKILL.md and all four language references on first run", () => {
		deployDapSkill(dir)

		for (const rel of files) {
			expect(readFileSync(join(dir, rel), "utf-8")).toBe(sourceContent(rel))
		}
	})

	it("is idempotent on redeploy", () => {
		deployDapSkill(dir)
		deployDapSkill(dir)

		for (const rel of files) {
			expect(readFileSync(join(dir, rel), "utf-8")).toBe(sourceContent(rel))
		}
	})

	it("overwrites stale content with the bundled version", () => {
		deployDapSkill(dir)
		writeFileSync(join(dir, "references/go.md"), "user-edited stale content")

		deployDapSkill(dir)

		expect(readFileSync(join(dir, "references/go.md"), "utf-8")).toBe(sourceContent("references/go.md"))
	})

	it("SKILL.md frontmatter declares name, description, and links all references", () => {
		const skill = sourceContent("SKILL.md")
		expect(skill).toMatch(/^---\nname: dap-debugging\n/)
		expect(skill).toMatch(/^description: /m)
		for (const rel of files.filter((f) => f !== "SKILL.md")) {
			expect(skill).toContain(rel)
		}
	})
})
