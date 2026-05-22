/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .kimchi/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import { DEFAULT_AGENTS } from "./default-agents.js"
import { AGENT_GENERAL_PURPOSE, type AgentConfig } from "./types.js"

/** All known built-in tool names. */
export const BUILTIN_TOOL_NAMES: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"]

/** Unified runtime registry of all agents (defaults + user-defined). */
const agents = new Map<string, AgentConfig>()

/** Lowercase-name → canonical-name index, kept in sync with `agents` for O(1) case-insensitive resolution. */
const lowerCaseIndex = new Map<string, string>()

/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 */
export function registerAgents(userAgents: Map<string, AgentConfig>): void {
	agents.clear()
	lowerCaseIndex.clear()

	for (const [name, config] of DEFAULT_AGENTS) {
		agents.set(name, config)
		lowerCaseIndex.set(name.toLowerCase(), name)
	}

	for (const [name, config] of userAgents) {
		agents.set(name, config)
		lowerCaseIndex.set(name.toLowerCase(), name)
	}
}

/** Case-insensitive key resolution. O(1) via the lowercase-name index. */
function resolveKey(name: string): string | undefined {
	if (agents.has(name)) return name
	return lowerCaseIndex.get(name.toLowerCase())
}

/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
	return resolveKey(name)
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
	const key = resolveKey(name)
	return key ? agents.get(key) : undefined
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
	return [...agents.entries()].filter(([_, config]) => config.enabled !== false).map(([name]) => name)
}

/** Get all type names including disabled (for UI listing). */
export function getAllTypes(): string[] {
	return [...agents.keys()]
}

/** Get names of default agents currently in the registry. */
export function getDefaultAgentNames(): string[] {
	return [...agents.entries()].filter(([_, config]) => config.isDefault === true).map(([name]) => name)
}

/** Get names of user-defined agents (non-defaults) currently in the registry. */
export function getUserAgentNames(): string[] {
	return [...agents.entries()].filter(([_, config]) => config.isDefault !== true).map(([name]) => name)
}

/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type: string): boolean {
	const key = resolveKey(type)
	if (!key) return false
	return agents.get(key)?.enabled !== false
}

/** Tool names required for memory management. */
const MEMORY_TOOL_NAMES = ["read", "write", "edit"]

/** Get memory tool names (read/write/edit) not already in the provided set. */
export function getMemoryToolNames(existingToolNames: Set<string>): string[] {
	return MEMORY_TOOL_NAMES.filter((n) => !existingToolNames.has(n))
}

/** Tool names needed for read-only memory access. */
const READONLY_MEMORY_TOOL_NAMES = ["read"]

/** Get read-only memory tool names not already in the provided set. */
export function getReadOnlyMemoryToolNames(existingToolNames: Set<string>): string[] {
	return READONLY_MEMORY_TOOL_NAMES.filter((n) => !existingToolNames.has(n))
}

/** Get built-in tool names for a type (case-insensitive). */
export function getToolNamesForType(type: string): string[] {
	const key = resolveKey(type)
	const raw = key ? agents.get(key) : undefined
	const config = raw?.enabled !== false ? raw : undefined
	const names = config?.builtinToolNames !== undefined ? config.builtinToolNames : [...BUILTIN_TOOL_NAMES]
	return names
}

/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object). Falls back to General-Purpose. */
export function getConfig(type: string): {
	displayName: string
	description: string
	builtinToolNames: string[]
	extensions: true | string[] | false
	skills: true | string[] | false
	promptMode: "replace" | "append"
} {
	const key = resolveKey(type)
	const config = key ? agents.get(key) : undefined
	if (config && config.enabled !== false) {
		return {
			displayName: config.displayName ?? config.name,
			description: config.description,
			builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
			extensions: config.extensions,
			skills: config.skills,
			promptMode: config.promptMode,
		}
	}

	const gp = agents.get(AGENT_GENERAL_PURPOSE)
	if (gp && gp.enabled !== false) {
		return {
			displayName: gp.displayName ?? gp.name,
			description: gp.description,
			builtinToolNames: gp.builtinToolNames ?? BUILTIN_TOOL_NAMES,
			extensions: gp.extensions,
			skills: gp.skills,
			promptMode: gp.promptMode,
		}
	}

	return {
		displayName: "General Purpose",
		description: "General purpose agent for all kind of tasks.",
		builtinToolNames: BUILTIN_TOOL_NAMES,
		extensions: true,
		skills: true,
		promptMode: "append",
	}
}
