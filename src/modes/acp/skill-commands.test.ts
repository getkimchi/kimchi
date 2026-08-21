import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"

function makeSkill(dir: string, name: string, description: string, body = "Skill body."): string {
	const skillDir = join(dir, name)
	mkdirSync(skillDir, { recursive: true })
	const filePath = join(skillDir, "SKILL.md")
	writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n${body}`, "utf-8")
	return filePath
}

import {
	type AcpSkillInfo,
	buildSkillAvailableCommands,
	buildSkillCommandPrompt,
	buildSkillListBlock,
	discoverAcpSkillCommands,
	tryParseSkillCommand,
} from "./skill-commands.js"

describe("discoverAcpSkillCommands", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-skills-"))
	})

	it("discovers native skills under DEFAULT_SKILL_PATHS relative to cwd", () => {
		makeSkill(join(tmpDir, ".pi", "agent", "skills"), "test-pi", "Pi skill description")
		const skills = discoverAcpSkillCommands(tmpDir, { homeDir: tmpDir })
		expect(skills).toContainEqual(expect.objectContaining({ name: "test-pi", description: "Pi skill description" }))
	})

	it("discovers native skills under ~/.config/kimchi/harness/skills", () => {
		makeSkill(join(tmpDir, ".config", "kimchi", "harness", "skills"), "test-harness", "Harness skill description")
		const skills = discoverAcpSkillCommands(tmpDir, { homeDir: tmpDir })
		expect(skills).toContainEqual(
			expect.objectContaining({ name: "test-harness", description: "Harness skill description" }),
		)
	})

	it("discovers Claude Code skills under .claude/skills", () => {
		makeSkill(join(tmpDir, ".claude", "skills"), "test-claude", "Claude skill description")
		const skills = discoverAcpSkillCommands(tmpDir, { homeDir: tmpDir })
		expect(skills).toContainEqual(
			expect.objectContaining({ name: "test-claude", description: "Claude skill description" }),
		)
	})

	it("returns skills sorted by name", () => {
		makeSkill(join(tmpDir, ".claude", "skills"), "zebra", "Zebra skill")
		makeSkill(join(tmpDir, ".claude", "skills"), "alpha", "Alpha skill")
		const skills = discoverAcpSkillCommands(tmpDir, { homeDir: tmpDir })
		expect(skills.map((s) => s.name)).toEqual(["alpha", "zebra"])
	})

	it("later sources override earlier sources on name collision", () => {
		makeSkill(join(tmpDir, ".pi", "agent", "skills"), "shared", "Pi version")
		makeSkill(join(tmpDir, ".claude", "skills"), "shared", "Claude version")
		const skills = discoverAcpSkillCommands(tmpDir, { homeDir: tmpDir })
		const shared = skills.find((s) => s.name === "shared")
		expect(shared?.description).toBe("Claude version")
	})

	it("returns an empty array when no skill directories exist", () => {
		const skills = discoverAcpSkillCommands(tmpDir, { homeDir: tmpDir })
		expect(skills).toEqual([])
	})
})

describe("buildSkillAvailableCommands", () => {
	it("builds ACP AvailableCommand entries with skill:<name> command names", () => {
		const skills: AcpSkillInfo[] = [
			{ name: "typescript-safety", description: "TypeScript safety patterns", filePath: "/x/SKILL.md" },
		]
		const commands = buildSkillAvailableCommands(skills)
		expect(commands).toEqual([
			{
				name: "skill:typescript-safety",
				description: "TypeScript safety patterns",
				input: { hint: "Optional prompt to run with this skill loaded." },
			},
		])
	})

	it("falls back to a generated description when the skill has none", () => {
		const skills: AcpSkillInfo[] = [{ name: "empty-desc", description: "", filePath: "/x/SKILL.md" }]
		const commands = buildSkillAvailableCommands(skills)
		expect(commands[0]?.description).toBe("Invoke the empty-desc skill")
		expect(commands[0]?.name).toBe("skill:empty-desc")
	})
})

describe("tryParseSkillCommand", () => {
	it("returns undefined for text without the /skill: prefix", async () => {
		const skills = new Map<string, AcpSkillInfo>([
			["typescript-safety", { name: "typescript-safety", description: "", filePath: "" }],
		])
		expect(await tryParseSkillCommand("hello world", skills)).toBeUndefined()
		expect(await tryParseSkillCommand("/typescript-safety", skills)).toBeUndefined()
	})

	it("returns undefined for unknown command names", async () => {
		const skills = new Map<string, AcpSkillInfo>([
			["typescript-safety", { name: "typescript-safety", description: "", filePath: "" }],
		])
		expect(await tryParseSkillCommand("/skill:unknown", skills)).toBeUndefined()
	})

	it("returns undefined when the skill file cannot be read", async () => {
		const skills = new Map<string, AcpSkillInfo>([
			["missing", { name: "missing", description: "", filePath: "/no/such/SKILL.md" }],
		])
		expect(await tryParseSkillCommand("/skill:missing", skills)).toBeUndefined()
	})

	it("strips YAML frontmatter from the injected skill content", async () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-skill-frontmatter-"))
		const filePath = makeSkill(dir, "frontmatter-skill", "Frontmatter test", "Use strict types.")
		const skills = new Map<string, AcpSkillInfo>([
			["frontmatter-skill", { name: "frontmatter-skill", description: "", filePath }],
		])
		const result = await tryParseSkillCommand("/skill:frontmatter-skill review this", skills)
		expect(result).toBeDefined()
		expect(result?.skillContent).toBe("Use strict types.")
		expect(result?.skillContent).not.toContain("---")
		expect(result?.skillContent).not.toContain("name: frontmatter-skill")
		expect(result?.skillContent).not.toContain("description: Frontmatter test")
	})
})

describe("buildSkillListBlock", () => {
	it("returns an empty string when no skills are discovered", () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-no-skills-"))
		const block = buildSkillListBlock(dir, { homeDir: dir })
		expect(block).toBe("")
	})

	it("lists discovered native and Claude Code skills with descriptions", () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-skill-list-"))
		makeSkill(join(dir, ".pi", "agent", "skills"), "pi-skill", "Pi skill description")
		makeSkill(join(dir, ".claude", "skills"), "claude-skill", "Claude skill description")

		const block = buildSkillListBlock(dir)
		expect(block).toContain("## Available Skills")
		expect(block).toContain("Use the Skill tool")
		expect(block).toContain("/skill:<name>")
		expect(block).toContain("- **claude-skill**: Claude skill description")
		expect(block).toContain("- **pi-skill**: Pi skill description")
	})
})

describe("buildSkillCommandPrompt", () => {
	it("prepends skill content and keeps remaining user text", () => {
		const rewrite = {
			skillName: "typescript-safety",
			remainingText: "review this file",
			skillContent: "Use strict types.",
		}
		const prompt = buildSkillCommandPrompt(rewrite)
		expect(prompt).toBe("Invoking skill: typescript-safety\n\nUse strict types.\n\nreview this file")
	})

	it("returns only the skill content when no remaining text is provided", () => {
		const rewrite = { skillName: "typescript-safety", remainingText: "", skillContent: "Use strict types." }
		const prompt = buildSkillCommandPrompt(rewrite)
		expect(prompt).toBe("Invoking skill: typescript-safety\n\nUse strict types.")
	})
})
