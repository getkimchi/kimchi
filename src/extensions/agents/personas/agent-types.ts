/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .kimchi/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import { DEFAULT_AGENTS } from "./default-agents.js"
import type { AgentConfig } from "./types.js"

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

/** Get built-in tool names for a type (case-insensitive). Unknown or disabled types get NO tools — never widen a missing permission profile to the full set (issue #1678). */
export function getToolNamesForType(type: string): string[] {
	const key = resolveKey(type)
	const raw = key ? agents.get(key) : undefined
	const config = raw?.enabled !== false ? raw : undefined
	if (!config) return []
	const names = config.builtinToolNames !== undefined ? config.builtinToolNames : [...BUILTIN_TOOL_NAMES]
	return names
}

/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object). Unknown or disabled types get a fail-closed config: no tools, no extensions, no skills (issue #1678). */
export function getConfig(type: string): {
	displayName: string
	description: string
	builtinToolNames: string[]
	extensions: true | string[] | false
	skills: true | string[] | false
	promptMode: "replace" | "append"
} {
	if (type === "Remote-Runner") {
		return {
			displayName: "Remote Agent",
			description: "Remote agent running on a sandbox worker via ACP",
			builtinToolNames: [],
			extensions: false,
			skills: false,
			promptMode: "replace" as const,
		}
	}
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

	// Fail closed: an unknown or disabled type has no permission profile, so it
	// must not inherit General-Purpose's (all builtin tools + extensions +
	// skills). The Agent tool boundary rejects unknown types before this is
	// reachable for spawning; this config also serves display-only callers
	// (e.g. the agent widget rendering a typo'd type mid-stream).
	return {
		displayName: type,
		description: `Unknown agent type "${type}"`,
		builtinToolNames: [],
		extensions: false,
		skills: false,
		promptMode: "append",
	}
}
