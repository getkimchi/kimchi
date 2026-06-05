import { CLAUDE_CODE_SKILLS_RESOURCE_ID } from "../extensions/claude-code-skills/definition.js"
import { PI_PACKAGE_LOOKUP_RESOURCE_ID } from "../extensions/pi-package-lookup/index.js"
import { discoverBashHookResources } from "./bash-hook-discovery.js"
import { discoverClaudeCodeHookResourceDefinitions } from "./claude-code-hook-resources.js"
import { discoverPackageResources } from "./package-resources.js"
import type { ResourceDefinition, ResourceKind } from "./types.js"

export const STATIC_RESOURCE_DEFINITIONS: readonly ResourceDefinition[] = [
	{
		id: "hooks.bash",
		kind: "hooks",
		label: "Bash hooks",
		description: "Enable Bash hook scripts discovered from hooks/bash directories.",
		defaultEnabled: true,
	},
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
		id: "extensions.claude-code-hook-adapter",
		kind: "extensions",
		label: "Claude Code hook adapter",
		description: "Run Claude Code command hooks from .claude settings files.",
		defaultEnabled: false,
		restartRequired: true,
	},
	{
		id: CLAUDE_CODE_SKILLS_RESOURCE_ID,
		kind: "extensions",
		label: "Claude Code skills",
		description: "Load Claude Code skills from .claude/skills into Kimchi's native skill prompt.",
		defaultEnabled: false,
		restartRequired: true,
	},
	{
		id: PI_PACKAGE_LOOKUP_RESOURCE_ID,
		kind: "extensions",
		label: "Pi package lookup",
		description: "Load packages installed by the original pi CLI.",
		defaultEnabled: false,
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

let dynamicResourceDefinitionsCache: ResourceDefinition[] | undefined

function getDynamicResourceDefinitions(): ResourceDefinition[] {
	if (dynamicResourceDefinitionsCache === undefined) {
		dynamicResourceDefinitionsCache = [
			...discoverBashHookResources(),
			...discoverClaudeCodeHookResourceDefinitions(),
			...discoverPackageResources(),
		]
	}
	return dynamicResourceDefinitionsCache
}

export function invalidateResourceDefinitionsCache(): void {
	dynamicResourceDefinitionsCache = undefined
}

export function getResourceDefinitions(): ResourceDefinition[] {
	return [...STATIC_RESOURCE_DEFINITIONS, ...getDynamicResourceDefinitions()]
}

export function getResourceDefinition(id: string): ResourceDefinition | undefined {
	return staticDefinitionsById.get(id) ?? getDynamicResourceDefinitions().find((d) => d.id === id)
}

export function getResourcesByKind(kind: ResourceKind): ResourceDefinition[] {
	return getResourceDefinitions().filter((definition) => definition.kind === kind)
}
