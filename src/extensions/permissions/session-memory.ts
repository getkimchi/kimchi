import { FILE_TOOLS, extractBashProgram } from "./taxonomy.js"
import type { Rule } from "./types.js"

export interface Scope {
	toolName: string
	content?: string
	wildcardContent?: string
	label: string
}

export class SessionMemory {
	private rules: Rule[] = []

	add(rule: Rule): void {
		this.rules.push(rule)
	}

	addMany(rules: Rule[]): void {
		this.rules.push(...rules)
	}

	all(): Rule[] {
		return [...this.rules]
	}

	clear(): void {
		this.rules = []
	}
}

// Scope suggestion for "don't ask again this session":
//   bash  → `program[ subcommand]:*` (subcommand dropped when it's a flag)
//   file  → directory glob (`src/cli.ts` → `src/**`)
//   other → tool name only
export function suggestScope(toolName: string, input: Record<string, unknown>): Scope {
	const lower = toolName.toLowerCase()

	if (lower === "bash") {
		const command = typeof input.command === "string" ? input.command : ""
		const prefix = bashPrefixScope(command)
		if (prefix) {
			return {
				toolName: lower,
				content: `${prefix}:*`,
				wildcardContent: `${bashProgramOnly(command)} *`,
				label: `bash(${prefix}:*)`,
			}
		}
		return { toolName: lower, content: undefined, label: "bash" }
	}

	if (FILE_TOOLS.has(lower)) {
		const path = typeof input.path === "string" ? input.path : ""
		const glob = dirGlob(path)
		if (glob) {
			return { toolName: lower, content: glob, label: `${lower}(${glob})` }
		}
		return { toolName: lower, content: undefined, label: lower }
	}

	return { toolName: lower, content: undefined, label: lower }
}

function bashProgramOnly(command: string): string {
	const trimmed = command.trim()
	if (!trimmed) return ""
	const { program } = extractBashProgram(trimmed)
	return program
}

function bashPrefixScope(command: string): string | null {
	const trimmed = command.trim()
	if (!trimmed) return null

	const { program, subcommand } = extractBashProgram(trimmed)
	if (!program) return null
	if (!subcommand || subcommand.startsWith("-")) return program
	return `${program} ${subcommand}`
}

function dirGlob(path: string): string | null {
	if (!path) return null
	const idx = path.lastIndexOf("/")
	if (idx <= 0) return path
	return `${path.slice(0, idx)}/**`
}
