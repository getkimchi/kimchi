import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent"
import { getAgentDir, loadSkills, loadSkillsFromDir } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { Static } from "typebox"
import { loadConfig } from "../../config.js"
import {
	expandConfiguredSkillPaths,
	findNearestAncestorSkillDir,
	getClaudeCodeSkillResourcePaths,
} from "./definition.js"

interface SkillToolDetails {
	success: boolean
	name?: string
	filePath?: string
	error?: string
}

const SkillToolSchema = Type.Object({
	skill: Type.Optional(Type.String({ description: "Claude Code skill name to load, e.g. typescript-safety." })),
	name: Type.Optional(Type.String({ description: "Alias for skill." })),
})

type SkillToolArgs = Static<typeof SkillToolSchema>

export default function claudeCodeSkillsExtension(pi: ExtensionAPI): void {
	pi.on("resources_discover", (event) => {
		const skillPaths = getClaudeCodeSkillResourcePaths(event.cwd, {
			excludeSkillPaths: loadConfig({ cwd: event.cwd }).skillPaths ?? [],
		})
		if (skillPaths.length === 0) return undefined
		return { skillPaths }
	})

	pi.registerTool({
		name: "Skill",
		label: "Skill",
		description:
			"Claude Code compatibility tool. Loads a named Claude Code skill from ~/.claude/skills or the current project .claude/skills directory when cwd contains .claude.",
		promptSnippet: "Load a Claude Code skill by name",
		parameters: SkillToolSchema,
		prepareArguments(args): SkillToolArgs {
			if (typeof args === "string") return { skill: args }
			if (isRecord(args) && typeof args.name === "string" && typeof args.skill !== "string") {
				return { ...args, skill: args.name } as SkillToolArgs
			}
			return (isRecord(args) ? args : {}) as SkillToolArgs
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const name = (params.skill ?? params.name)?.trim()
			if (!name) {
				return {
					content: [{ type: "text" as const, text: "Skill name is required." }],
					details: { success: false, error: "Skill name is required." } satisfies SkillToolDetails,
				}
			}

			const skill = findClaudeCodeSkill(ctx.cwd, name)
			if (!skill) {
				const message = `Claude Code skill "${name}" was not found.`
				return {
					content: [{ type: "text" as const, text: message }],
					details: { success: false, name, error: message } satisfies SkillToolDetails,
				}
			}

			try {
				const content = readFileSync(skill.filePath, "utf-8").trim()
				return {
					content: [
						{
							type: "text" as const,
							text: `Loaded Skill("${skill.name}") from ${skill.filePath}\n\n${content}`,
						},
					],
					details: { success: true, name: skill.name, filePath: skill.filePath } satisfies SkillToolDetails,
				}
			} catch {
				const message = `Claude Code skill "${name}" could not be read.`
				return {
					content: [{ type: "text" as const, text: message }],
					details: { success: false, name, filePath: skill.filePath, error: message } satisfies SkillToolDetails,
				}
			}
		},
	})
}

function findClaudeCodeSkill(cwd: string, name: string): Skill | undefined {
	const nativeSkill = findNativeSkill(cwd, name)
	if (nativeSkill) return nativeSkill

	for (const dir of getClaudeCodeSkillResourcePaths(cwd, { excludeNativeSkillNames: false })) {
		let result: ReturnType<typeof loadSkillsFromDir>
		try {
			result = loadSkillsFromDir({ dir, source: dir })
		} catch {
			continue
		}
		const skill = result.skills.find((s) => s.name === name)
		if (skill) return skill
	}
	return undefined
}

function findNativeSkill(cwd: string, name: string): Skill | undefined {
	const config = loadConfig({ cwd })
	const result = loadSkills({
		cwd,
		agentDir: getAgentDir(),
		skillPaths: getNativeSkillSearchPaths(cwd, config.skillPaths ?? []),
		includeDefaults: false,
	})
	return result.skills.find((skill) => skill.name === name)
}

function getNativeSkillSearchPaths(cwd: string, configuredSkillPaths: string[]): string[] {
	const ancestorAgentsSkills = findNearestAncestorSkillDir(cwd, join(".agents", "skills"))
	const paths = [
		resolve(cwd, ".pi", "skills"),
		...(ancestorAgentsSkills ? [ancestorAgentsSkills] : []),
		...expandConfiguredSkillPaths(configuredSkillPaths, cwd).filter((path) => !isClaudeSkillPath(path)),
		join(homedir(), ".config", "kimchi", "harness", "skills"),
		join(homedir(), ".pi", "agent", "skills"),
		join(homedir(), ".agents", "skills"),
	]

	const seen = new Set<string>()
	const result: string[] = []
	for (const path of paths) {
		const resolved = resolve(path)
		if (seen.has(resolved)) continue
		seen.add(resolved)
		result.push(resolved)
	}
	return result
}

function isClaudeSkillPath(path: string): boolean {
	return path.split(/[\\/]+/).includes(".claude")
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}
