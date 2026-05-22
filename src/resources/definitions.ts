import { discoverBashHookResources } from "./bash-hook-discovery.js"
import type { ResourceDefinition, ResourceKind } from "./types.js"

export const STATIC_RESOURCE_DEFINITIONS: readonly ResourceDefinition[] = [
	{
		id: "hooks.rtk-rewrite",
		kind: "hooks",
		label: "RTK rewrite",
		description: "Rewrite Bash commands through rtk before execution.",
		defaultEnabled: true,
	},
	{
		id: "tools.web_search",
		kind: "tools",
		label: "Web search",
		description: "Allow the web_search tool.",
		defaultEnabled: true,
		restartRequired: true,
	},
	{
		id: "tools.web_fetch",
		kind: "tools",
		label: "Web fetch",
		description: "Allow the web_fetch tool.",
		defaultEnabled: true,
		restartRequired: true,
	},
	{
		id: "extensions.agents",
		kind: "extensions",
		label: "Agents",
		description: "Enable subagent delegation tools.",
		defaultEnabled: true,
		restartRequired: true,
	},
	{
		id: "extensions.ferment",
		kind: "extensions",
		label: "Ferment",
		description: "Enable guided project workflow tools.",
		defaultEnabled: true,
		restartRequired: true,
	},
	{
		id: "plugins.mcp-apps",
		kind: "plugins",
		label: "MCP apps",
		description: "Enable MCP/app connector tools.",
		defaultEnabled: true,
		restartRequired: true,
	},
]

export const RESOURCE_KINDS: readonly ResourceKind[] = ["hooks", "tools", "extensions", "plugins"]

export const TOOL_RESOURCE_IDS: Readonly<Record<string, string>> = {
	web_search: "tools.web_search",
	web_fetch: "tools.web_fetch",
}

const staticDefinitionsById = new Map(STATIC_RESOURCE_DEFINITIONS.map((definition) => [definition.id, definition]))

export function getResourceDefinitions(): ResourceDefinition[] {
	return [...STATIC_RESOURCE_DEFINITIONS, ...discoverBashHookResources()]
}

export function getResourceDefinition(id: string): ResourceDefinition | undefined {
	return staticDefinitionsById.get(id) ?? discoverBashHookResources().find((definition) => definition.id === id)
}

export function getResourcesByKind(kind: ResourceKind): ResourceDefinition[] {
	return getResourceDefinitions().filter((definition) => definition.kind === kind)
}
