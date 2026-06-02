import type { AgentConfig } from "./personas/types.js"

export const SUBAGENT_INTERNAL_TODOS_ENV = "KIMCHI_SUBAGENT_INTERNAL_TODOS"

function flagDisabled(value: string | undefined): boolean {
	if (value === undefined) return false
	const normalized = value.trim().toLowerCase()
	return normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no"
}

export function isSubagentInternalTodosRuntimeEnabled(): boolean {
	return !flagDisabled(process.env[SUBAGENT_INTERNAL_TODOS_ENV])
}

export function extensionsMayProvideTodos(extensions: AgentConfig["extensions"] | undefined): boolean {
	if (extensions === false) return false
	if (extensions === undefined || extensions === true) return true
	return extensions.some((entry) => {
		const normalized = entry.trim().toLowerCase()
		return (
			normalized === "todos" ||
			normalized === "todo" ||
			normalized === "extensions.todos" ||
			normalized === "write_todos"
		)
	})
}

export function toolMatchesExtensionAllowlist(toolName: string, extensions: string[]): boolean {
	if (toolName === "write_todos" && extensionsMayProvideTodos(extensions as AgentConfig["extensions"])) {
		return true
	}
	return extensions.some((ext) => toolName.startsWith(ext) || toolName.includes(ext))
}

export function shouldEnableSubagentInternalTodos(
	agentConfig: Pick<AgentConfig, "internalTodos" | "extensions" | "disallowedTools"> | undefined,
	extensions: AgentConfig["extensions"],
): boolean {
	if (!isSubagentInternalTodosRuntimeEnabled()) return false
	if (agentConfig?.internalTodos === false) return false
	if (agentConfig?.disallowedTools?.includes("write_todos")) return false
	return extensionsMayProvideTodos(extensions)
}

export function renderSubagentInternalTodosPromptBlock(agentName?: string): string {
	const label = agentName ? ` for ${agentName}` : ""
	return `<internal_todos>
write_todos is available as your private tactical todo board${label}.
- Use it for multi-step delegated work where a short checklist improves execution.
- Do not use it for a single straightforward lookup, one-command task, or purely conversational answer.
- Omit the scope field; your writes are scoped to this subagent's internal board.
- Keep items tactical, keep at most one item in_progress, and update after meaningful progress.
- These todos are for your own work. They do not edit the parent session's global todos or Ferment plan.
</internal_todos>`
}
