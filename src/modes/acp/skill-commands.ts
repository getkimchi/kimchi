import { readFile } from "node:fs/promises"
import type { AvailableCommand } from "@agentclientprotocol/sdk"
import { loadSkillsFromDir, stripFrontmatter } from "@earendil-works/pi-coding-agent"
import { DEFAULT_SKILL_PATHS } from "../../config.js"
import { resolvePromptSkillPaths } from "../../shared/skill-discovery/resolve-prompt-skill-paths.js"

export interface AcpSkillInfo {
	readonly name: string
	readonly description: string
	readonly filePath: string
}

export interface DiscoverAcpSkillCommandsOptions {
	/** Override for os.homedir(), useful for tests. Defaults to homedir(). */
	readonly homeDir?: string
	/** Configured skill resource paths; defaults to DEFAULT_SKILL_PATHS. Override in tests for hermetic discovery. */
	readonly skillPaths?: readonly string[]
	/** Whether Claude Code skills participate; defaults to the extension's resource toggle. */
	readonly includeClaudeCodeSkills?: boolean
	/** Whether installed-package skill dirs participate; defaults to true. Tests disable for hermetic discovery. */
	readonly includePackageDirs?: boolean
	/** Override for the bundled skills dir; `null` disables it (set in tests for isolation). */
	readonly bundledDir?: string | null
}

/**
 * Discover all skills that should be advertised as ACP slash commands for the
 * given working directory. Uses the same prompt-time composition as
 * prompt-enrichment (project > configured > Claude Code > packages > bundled,
 * strongest-first first-wins on name collisions) so the skills a user sees in
 * the prompt and over ACP are always the same set.
 */
export function discoverAcpSkillCommands(cwd: string, options: DiscoverAcpSkillCommandsOptions = {}): AcpSkillInfo[] {
	const byName = new Map<string, AcpSkillInfo>()

	for (const dir of resolvePromptSkillPaths({
		cwd,
		skillPaths: options.skillPaths ?? DEFAULT_SKILL_PATHS,
		homeDir: options.homeDir,
		bundledDir: options.bundledDir,
		includeClaudeCodeSkills: options.includeClaudeCodeSkills,
		includePackageDirs: options.includePackageDirs,
	})) {
		try {
			const { skills } = loadSkillsFromDir({ dir, source: dir })
			for (const skill of skills) {
				// Paths arrive strongest-first; keep the first occurrence (first-wins),
				// matching pi's loadSkills collision semantics.
				if (!byName.has(skill.name)) {
					byName.set(skill.name, {
						name: skill.name,
						description: skill.description ?? "",
						filePath: skill.filePath,
					})
				}
			}
		} catch {
			// Directory missing or unreadable — skip silently.
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
 * the system prompt. Returns an empty string when no skills are discovered.
 */
export function buildSkillListBlock(
	cwd: string,
	options: Pick<
		DiscoverAcpSkillCommandsOptions,
		"homeDir" | "bundledDir" | "skillPaths" | "includeClaudeCodeSkills" | "includePackageDirs"
	> = {},
): string {
	const skills = discoverAcpSkillCommands(cwd, options)
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
