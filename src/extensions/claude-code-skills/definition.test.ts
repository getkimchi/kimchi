import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	discoverClaudeCodeSkillDirs,
	getClaudeCodeSkillResourcePaths,
	getConfiguredSkillResourcePaths,
	sanitizeSkillMarkdown,
} from "./definition.js"

let dir: string
let oldHome: string | undefined

describe("Claude Code skill discovery", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-claude-code-skills-"))
		oldHome = process.env.HOME
		process.env.HOME = join(dir, "home")
	})

	afterEach(() => {
		if (oldHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		rmSync(dir, { recursive: true, force: true })
	})

	it("discovers user and current-project Claude Code skill directories", () => {
		const userSkills = join(dir, "home", ".claude", "skills")
		const projectSkills = join(dir, "project", ".claude", "skills")
		writeSkill(join(userSkills, "user-only", "SKILL.md"))
		writeSkill(join(projectSkills, "project-only", "SKILL.md"))

		expect(discoverClaudeCodeSkillDirs(join(dir, "project"))).toEqual([userSkills, projectSkills])
	})

	it("does not return missing or duplicate skill directories", () => {
		const skills = join(dir, "home", ".claude", "skills")
		writeSkill(join(skills, "shared", "SKILL.md"))

		expect(discoverClaudeCodeSkillDirs(join(dir, "home"))).toEqual([skills])
	})

	it("does not discover Claude Code skill directories without cwd .claude", () => {
		const project = join(dir, "project")
		writeSkill(join(project, ".claude", "skills", "typescript-safety", "SKILL.md"))

		expect(discoverClaudeCodeSkillDirs(join(project, "src"))).toEqual([])
	})

	it("materializes Claude Code skill directories into sanitized cache paths", () => {
		const projectSkills = join(dir, "project", ".claude", "skills")
		writeSkill(
			join(projectSkills, "TypeScript Safety", "SKILL.md"),
			"---\ndescription: Use: generated API types\ntools: Read, Write\n---\n# Body\n",
		)

		const paths = getClaudeCodeSkillResourcePaths(join(dir, "project"))

		expect(paths).toHaveLength(1)
		expect(paths[0]).toContain("kimchi-claude-code-skills-")
		expect(readFileSync(join(paths[0], "SKILL.md"), "utf-8")).toBe(
			'---\nname: "typescript-safety"\ndescription: "Use: generated API types"\n---\n# Body\n',
		)
	})

	it("sanitizes loose Claude Code skill frontmatter", () => {
		expect(sanitizeSkillMarkdown("---\ndescription: Use: colons safely\n---\nBody\n", "My Skill")).toBe(
			'---\nname: "my-skill"\ndescription: "Use: colons safely"\n---\nBody\n',
		)
	})

	it("adds generated frontmatter to Claude Code skills without frontmatter", () => {
		expect(sanitizeSkillMarkdown("# Body\n", "My Skill")).toBe(
			'---\nname: my-skill\ndescription: "Claude Code skill: my-skill."\n---\n# Body\n',
		)
	})

	it("adds a fallback description when frontmatter only provides a name", () => {
		expect(sanitizeSkillMarkdown("---\nname: My Skill\n---\nBody\n", "Fallback")).toBe(
			'---\nname: my-skill\ndescription: "Claude Code skill: my-skill."\n---\nBody\n',
		)
	})

	it("adds a fallback description when frontmatter description is blank", () => {
		expect(sanitizeSkillMarkdown('---\nname: My Skill\ndescription: "   "\n---\nBody\n', "Fallback")).toBe(
			'---\nname: my-skill\ndescription: "Claude Code skill: my-skill."\n---\nBody\n',
		)
	})

	it("trims parsed frontmatter descriptions", () => {
		expect(sanitizeSkillMarkdown('---\nname: My Skill\ndescription: " real desc "\n---\nBody\n', "Fallback")).toBe(
			"---\nname: my-skill\ndescription: real desc\n---\nBody\n",
		)
	})

	it("sanitizes valid skill frontmatter with YAML parsing", () => {
		expect(
			sanitizeSkillMarkdown(
				'---\nname: My Skill\ndescription: "true"\nmetadata:\n  count: 1\nallowed-tools:\n  - Read\n---\nBody\n',
				"Fallback",
			),
		).toBe('---\nname: my-skill\ndescription: "true"\nmetadata:\n  count: 1\n---\nBody\n')
	})

	it("preserves quoted loose scalar types when repairing invalid frontmatter", () => {
		expect(
			sanitizeSkillMarkdown('---\ndescription: "true"\nmetadata: Use: colons safely\n---\nBody\n', "My Skill"),
		).toBe('---\nname: "my-skill"\ndescription: "true"\nmetadata: "Use: colons safely"\n---\nBody\n')
	})

	it("preserves block scalar description bodies when repairing invalid frontmatter", () => {
		expect(
			sanitizeSkillMarkdown(
				"---\ndescription: |\n  Use: generated types\n  Keep: safe\nmetadata: Use: colons safely\n---\nBody\n",
				"My Skill",
			),
		).toBe(
			'---\nname: "my-skill"\ndescription: |\n  Use: generated types\n  Keep: safe\nmetadata: "Use: colons safely"\n---\nBody\n',
		)
	})

	it("preserves block scalar description headers with chomping and indentation indicators", () => {
		expect(
			sanitizeSkillMarkdown(
				"---\ndescription: >-\n  Use: generated types\n  Keep: safe\nmetadata: Use: colons safely\n---\nBody\n",
				"My Skill",
			),
		).toBe(
			'---\nname: "my-skill"\ndescription: >-\n  Use: generated types\n  Keep: safe\nmetadata: "Use: colons safely"\n---\nBody\n',
		)
		expect(
			sanitizeSkillMarkdown(
				"---\ndescription: |+2\n  Use: generated types\n  Keep: safe\nmetadata: Use: colons safely\n---\nBody\n",
				"My Skill",
			),
		).toBe(
			'---\nname: "my-skill"\ndescription: |+2\n  Use: generated types\n  Keep: safe\nmetadata: "Use: colons safely"\n---\nBody\n',
		)
	})

	it("adds a fallback description for empty block scalar descriptions when repairing invalid frontmatter", () => {
		expect(sanitizeSkillMarkdown("---\ndescription: |\n\nmetadata: Use: colons safely\n---\nBody\n", "My Skill")).toBe(
			'---\nname: "my-skill"\ndescription: "Claude Code skill: my-skill."\nmetadata: "Use: colons safely"\n---\nBody\n',
		)
	})

	it("does not treat prefixed fences as closing frontmatter", () => {
		const content = "---\ndescription: Test\n---not-a-fence\nBody\n"

		expect(sanitizeSkillMarkdown(content, "My Skill")).toBe(
			'---\nname: my-skill\ndescription: "Claude Code skill: my-skill."\n---\n---\ndescription: Test\n---not-a-fence\nBody\n',
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

	it("materializes Claude Code skills even when native project skills use the same name", () => {
		const cwd = join(dir, "project")
		writeSkill(join(cwd, ".agents", "skills", "typescript-safety", "SKILL.md"))
		writeSkill(join(cwd, ".claude", "skills", "typescript-safety", "SKILL.md"))

		expect(getClaudeCodeSkillResourcePaths(cwd)).toHaveLength(1)
	})

	it("does not materialize Claude Code skills from an ancestor .claude directory", () => {
		const project = join(dir, "project")
		const cwd = join(project, "src", "feature")
		writeSkill(join(project, ".claude", "skills", "typescript-safety", "SKILL.md"))

		expect(getClaudeCodeSkillResourcePaths(cwd)).toEqual([])
	})

	it("materializes Claude Code skill paths through the sanitized cache", () => {
		const cwd = join(dir, "project")
		writeSkill(
			join(cwd, ".claude", "skills", "typescript-safety", "SKILL.md"),
			"---\ndescription: Use: generated API types\ntools: Read, Write\n---\n# Skill\n",
		)

		const paths = getClaudeCodeSkillResourcePaths(cwd)

		expect(paths).toHaveLength(1)
		expect(paths[0]).toContain("kimchi-claude-code-skills-")
		expect(readFileSync(join(paths[0], "SKILL.md"), "utf-8")).toBe(
			'---\nname: "typescript-safety"\ndescription: "Use: generated API types"\n---\n# Skill\n',
		)
	})

	it("materializes configured Claude Code skill files through the sanitized cache", () => {
		const cwd = join(dir, "project")
		writeSkill(join(cwd, ".claude", "skills", "typescript-safety", "SKILL.md"), "Use generated types.\n")

		const paths = getConfiguredSkillResourcePaths(cwd, [".claude/skills/typescript-safety/SKILL.md"])

		expect(paths).toHaveLength(1)
		expect(paths[0]).toContain("kimchi-claude-code-skills-")
		expect(readFileSync(join(paths[0], "SKILL.md"), "utf-8")).toBe(
			'---\nname: typescript-safety\ndescription: "Claude Code skill: typescript-safety."\n---\nUse generated types.\n',
		)
	})

	it("keeps a configured native skill file ahead of a matching Claude Code skill", () => {
		const cwd = join(dir, "project")
		const claudeSkills = join(cwd, ".claude", "skills")
		const nativeSkill = join(cwd, ".agents", "skills", "typescript-safety", "SKILL.md")
		writeSkill(join(claudeSkills, "typescript-safety", "SKILL.md"))
		writeSkill(nativeSkill)

		expect(getConfiguredSkillResourcePaths(cwd, [claudeSkills, nativeSkill])).toEqual([nativeSkill])
	})
})

function writeSkill(path: string, content = "---\ndescription: Test skill.\n---\n# Skill\n"): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, content, "utf-8")
}
