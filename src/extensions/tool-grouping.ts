import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent"
import { Container, Spacer } from "@earendil-works/pi-tui"
import { ToolBlockView } from "../components/tool-block.js"
import { isToolExpanded } from "../expand-state.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Category = "file" | "pattern" | "directory" | "edit" | "command" | "operation"

// ---------------------------------------------------------------------------
// classifyTool
// ---------------------------------------------------------------------------

const BASH_DIRECTORY_CMDS = new Set(["ls", "fd", "find"])
const BASH_PATTERN_CMDS = new Set(["grep", "rg"])
const BASH_FILE_CMDS = new Set(["cat", "head", "tail"])

export function classifyTool(toolName: string, args: Record<string, unknown>): Category {
	switch (toolName) {
		case "read":
			return "file"
		case "grep":
		case "find":
			return "pattern"
		case "ls":
			return "directory"
		case "write":
		case "edit":
		case "multiedit":
			return "edit"
		case "bash": {
			const command = typeof args.command === "string" ? args.command.trim() : ""
			const firstWord = command.split(/\s+/)[0] ?? ""
			if (BASH_DIRECTORY_CMDS.has(firstWord)) return "directory"
			if (BASH_PATTERN_CMDS.has(firstWord)) return "pattern"
			if (BASH_FILE_CMDS.has(firstWord)) return "file"
			return "command"
		}
		default:
			return "operation"
	}
}

// ---------------------------------------------------------------------------
// formatSummary
// ---------------------------------------------------------------------------

const PAST: Record<Category, (n: number) => string> = {
	file: (n) => `read ${n} ${n === 1 ? "file" : "files"}`,
	pattern: (n) => `searched for ${n} ${n === 1 ? "pattern" : "patterns"}`,
	directory: (n) => `listed ${n} ${n === 1 ? "directory" : "directories"}`,
	edit: (n) => `made ${n} ${n === 1 ? "edit" : "edits"}`,
	command: (n) => `ran ${n} ${n === 1 ? "command" : "commands"}`,
	operation: (n) => `${n} ${n === 1 ? "operation" : "operations"}`,
}

const CONTINUOUS: Record<Category, (n: number) => string> = {
	file: (n) => `reading ${n} ${n === 1 ? "file" : "files"}`,
	pattern: (n) => `searching for ${n} ${n === 1 ? "pattern" : "patterns"}`,
	directory: (n) => `listing ${n} ${n === 1 ? "directory" : "directories"}`,
	edit: (n) => `editing ${n} ${n === 1 ? "file" : "files"}`,
	command: (n) => `running ${n} ${n === 1 ? "command" : "commands"}`,
	operation: (n) => `${n} ${n === 1 ? "operation" : "operations"}`,
}

export function formatSummary(counts: Map<Category, number>, isInProgress: boolean): string {
	const table = isInProgress ? CONTINUOUS : PAST
	return Array.from(counts.entries())
		.map(([cat, n]) => table[cat](n))
		.join(", ")
}
