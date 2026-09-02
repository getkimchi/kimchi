import { readFile } from "node:fs/promises"
import type { AvailableCommand } from "@agentclientprotocol/sdk"
import type { ResourceLoader } from "@earendil-works/pi-coding-agent"
import { stripFrontmatter } from "@earendil-works/pi-coding-agent"

export interface AcpSkillInfo {
	readonly name: string
	readonly description: string
	readonly filePath: string
}

/**
 * Discover all skills that should be advertised as ACP slash commands. Reads
 * from pi's resolved resource inventory so the ACP view matches the base
 * prompt's skills section (same precedence, collision rules, trust, packages,
 * and extension contributions) instead of re-deriving skill locations here.
 */
export function discoverAcpSkillCommands(loader: ResourceLoader): AcpSkillInfo[] {
	const { skills } = loader.getSkills()
	const byName = new Map<string, AcpSkillInfo>()
	for (const skill of skills) {
		if (!byName.has(skill.name)) {
			byName.set(skill.name, {
				name: skill.name,
				description: skill.description ?? "",
				filePath: skill.filePath,
			})
		}
	}
	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
}

function skillCommandName(skillName: string): string {
	return `skill:${skillName}`
}

export function buildSkillAvailableCommands(skills: readonly AcpSkillInfo[]): AvailableCommand[] {
	return skills.map((skill) => ({
		name: skillCommandName(skill.name),
		description: skill.description || `Invoke the ${skill.name} skill`,
		input: {
			hint: "Optional prompt to run with this skill loaded.",
		},
	}))
}

/**
 * Build a compact markdown block listing available skills for injection into
 * the system prompt. Returns an empty string when the loader reports no skills.
 */
export function buildSkillListBlock(loader: ResourceLoader): string {
	const skills = discoverAcpSkillCommands(loader)
	if (skills.length === 0) return ""

	const lines = skills.map((s) => `- **${s.name}**: ${s.description || `Use the ${s.name} skill.`}`)
	return `## Available Skills

Use the Skill tool to load a skill's full instructions when its description matches your task. You can also invoke a skill for the current turn by starting your message with \`/skill:<name>\`.

${lines.join("\n")}`
}

export interface SkillCommandRewrite {
	readonly skillName: string
	readonly remainingText: string
	readonly skillContent: string
}

/**
 * Parse a prompt that starts with a skill command name (`/skill:<name>`).
 * Returns undefined if the text does not begin with `/skill:` or if the name
 * is not a known skill.
 */
export async function tryParseSkillCommand(
	text: string,
	skills: ReadonlyMap<string, AcpSkillInfo>,
): Promise<SkillCommandRewrite | undefined> {
	if (!text.startsWith("/skill:")) return undefined
	const withoutPrefix = text.slice("/skill:".length)
	const spaceIdx = withoutPrefix.search(/\s/)
	const name = spaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIdx)
	const remaining = spaceIdx === -1 ? "" : withoutPrefix.slice(spaceIdx + 1).trimStart()

	if (!name) return undefined
	const skill = skills.get(name)
	if (!skill) return undefined

	let rawContent: string
	try {
		rawContent = await readFile(skill.filePath, "utf-8")
	} catch {
		return undefined
	}

	const skillContent = stripFrontmatter(rawContent).trim()
	return { skillName: skill.name, remainingText: remaining, skillContent }
}

/**
 * Build the effective prompt text for a skill command invocation. The skill
 * content is injected as a clear prefix so the model applies it for this turn.
 */
export function buildSkillCommandPrompt(rewrite: SkillCommandRewrite): string {
	const { skillName, remainingText, skillContent } = rewrite
	const header = `Invoking skill: ${skillName}`
	const prefix = [header, "", skillContent].join("\n")
	return remainingText ? `${prefix}\n\n${remainingText}` : prefix
}
