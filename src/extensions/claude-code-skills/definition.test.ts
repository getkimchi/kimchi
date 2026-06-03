import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverClaudeCodeSkillDirs, getClaudeCodeSkillResourcePaths, sanitizeSkillMarkdown } from "./definition.js"

let dir: string
let oldHome: string | undefined
let oldXdgCacheHome: string | undefined

describe("Claude Code skill discovery", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-claude-code-skills-"))
		oldHome = process.env.HOME
		oldXdgCacheHome = process.env.XDG_CACHE_HOME
		process.env.HOME = join(dir, "home")
		process.env.XDG_CACHE_HOME = join(dir, "cache")
	})

	afterEach(() => {
		if (oldHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		if (oldXdgCacheHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.XDG_CACHE_HOME
		} else {
			process.env.XDG_CACHE_HOME = oldXdgCacheHome
		}
		rmSync(dir, { recursive: true, force: true })
	})

	it("discovers user and nearest-project Claude Code skill directories", () => {
		const userSkills = join(dir, "home", ".claude", "skills")
		const projectSkills = join(dir, "project", ".claude", "skills")
		writeSkill(join(userSkills, "user-only", "SKILL.md"))
		writeSkill(join(projectSkills, "project-only", "SKILL.md"))

		expect(discoverClaudeCodeSkillDirs(join(dir, "project", ".claude"))).toEqual([userSkills, projectSkills])
	})

	it("does not return missing or duplicate skill directories", () => {
		const skills = join(dir, "home", ".claude", "skills")
		writeSkill(join(skills, "shared", "SKILL.md"))

		expect(discoverClaudeCodeSkillDirs(join(dir, "home", ".claude", "skills", "shared"))).toEqual([skills])
	})

	it("materializes Claude Code skill directories into sanitized cache paths", () => {
		const projectSkills = join(dir, "project", ".claude", "skills")
		writeSkill(
			join(projectSkills, "TypeScript Safety", "SKILL.md"),
			"---\ndescription: Use: generated API types\ntools: Read, Write\n---\n# Body\n",
		)

		const paths = getClaudeCodeSkillResourcePaths(join(dir, "project"))

		expect(paths).toHaveLength(1)
		expect(paths[0]).toContain(join(dir, "cache", "kimchi", "claude-code-skills"))
		expect(readFileSync(join(paths[0], "SKILL.md"), "utf-8")).toBe(
			'---\nname: "typescript-safety"\ndescription: "Use: generated API types"\n---\n# Body\n',
		)
	})

	it("sanitizes loose Claude Code skill frontmatter", () => {
		expect(sanitizeSkillMarkdown("---\ndescription: Use: colons safely\n---\nBody\n", "My Skill")).toBe(
			'---\nname: "my-skill"\ndescription: "Use: colons safely"\n---\nBody\n',
		)
	})

	it("drops nested tool frontmatter sequences when sanitizing", () => {
		expect(
			sanitizeSkillMarkdown(
				"---\ndescription: Use: colons safely\ntools:\n  - Read\n  - Write\nallowed-tools:\n  - Bash\nname: My Skill\n---\nBody\n",
				"My Skill",
			),
		).toBe('---\ndescription: "Use: colons safely"\nname: "my-skill"\n---\nBody\n')
	})

	it("does not materialize Claude Code skills already present in native project skills", () => {
		const cwd = join(dir, "project")
		writeSkill(join(cwd, ".agents", "skills", "typescript-safety", "SKILL.md"))
		writeSkill(join(cwd, ".claude", "skills", "typescript-safety", "SKILL.md"))

		expect(getClaudeCodeSkillResourcePaths(cwd)).toEqual([])
	})

	it("does not materialize Claude Code skills already present in configured skill paths", () => {
		const cwd = join(dir, "project")
		writeSkill(join(cwd, ".custom", "skills", "typescript-safety", "SKILL.md"))
		writeSkill(join(cwd, ".claude", "skills", "typescript-safety", "SKILL.md"))

		expect(getClaudeCodeSkillResourcePaths(cwd, { excludeSkillPaths: [".custom/skills"] })).toEqual([])
	})
})

function writeSkill(path: string, content = "---\ndescription: Test skill.\n---\n# Skill\n"): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, content, "utf-8")
}
