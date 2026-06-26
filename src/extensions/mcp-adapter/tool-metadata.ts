import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge"
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import { resourceNameToToolName } from "./resource-tools.js"
import type { McpExtensionState } from "./state.js"
import type { McpResource, McpTool, ServerEntry, ToolMetadata } from "./types.js"
import { formatToolName, isToolExcluded } from "./types.js"
import { extractToolUiStreamMode } from "./utils.js"

/**
 * Heuristic name prefixes that indicate a read-only MCP tool when the server
 * does not populate `annotations.readOnlyHint`.
 */
const READ_ONLY_NAME_PREFIXES = /^(get_|search_|list_|read_|fetch_)/

/**
 * Returns true when an MCP tool is safe to call during read-only (scoping)
 * contexts. A tool qualifies when its `annotations.readOnlyHint` is explicitly
 * `true`, OR when annotations are absent and the tool's original name matches a
 * read-only heuristic prefix (`get_`, `search_`, `list_`, `read_`, `fetch_`).
 *
 * A tool with `readOnlyHint: false` (or any annotations present) is never
 * promoted by the heuristic — the explicit annotation wins.
 */
export function isReadOnlyMcpTool(meta: {
	originalName: string
	annotations?: ToolAnnotations
}): boolean {
	if (meta.annotations?.readOnlyHint === true) return true
	if (meta.annotations === undefined && READ_ONLY_NAME_PREFIXES.test(meta.originalName)) {
		// The name heuristic is best-effort: a tool with no annotations but a
		// read-only-prefixed name (e.g. `get_reset_database`) cannot be proven
		// safe, so we promote it and surface a warning so operators can audit
		// the classification. Servers SHOULD set readOnlyHint explicitly.
		console.warn(`[mcp] Tool "${meta.originalName}" promoted to read-only via name heuristic (no annotations)`)
		return true
	}
	return false
}

export function buildToolMetadata(
	tools: McpTool[],
	resources: McpResource[],
	definition: ServerEntry,
	serverName: string,
	prefix: "server" | "none" | "short",
): { metadata: ToolMetadata[]; failedTools: string[] } {
	const metadata: ToolMetadata[] = []
	const failedTools: string[] = []

	for (const tool of tools) {
		if (!tool?.name) {
			failedTools.push("(unnamed)")
			continue
		}
		if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) {
			continue
		}

		let uiResourceUri: string | undefined
		try {
			uiResourceUri = getToolUiResourceUri({ _meta: tool._meta })
		} catch {
			failedTools.push(tool.name)
		}
		metadata.push({
			name: formatToolName(tool.name, serverName, prefix),
			originalName: tool.name,
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
			uiResourceUri,
			uiStreamMode: extractToolUiStreamMode(tool._meta),
			annotations: tool.annotations,
		})
	}

	if (definition.exposeResources !== false) {
		for (const resource of resources) {
			const baseName = `get_${resourceNameToToolName(resource.name)}`
			if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) {
				continue
			}

			metadata.push({
				name: formatToolName(baseName, serverName, prefix),
				originalName: baseName,
				description: resource.description ?? `Read resource: ${resource.uri}`,
				resourceUri: resource.uri,
			})
		}
	}

	return { metadata, failedTools }
}

export function getToolNames(state: McpExtensionState, serverName: string): string[] {
	return state.toolMetadata.get(serverName)?.map((m) => m.name) ?? []
}

export function totalToolCount(state: McpExtensionState): number {
	let count = 0
	for (const metadata of state.toolMetadata.values()) {
		count += metadata.length
	}
	return count
}

export function findToolByName(metadata: ToolMetadata[] | undefined, toolName: string): ToolMetadata | undefined {
	if (!metadata) return undefined
	const exact = metadata.find((m) => m.name === toolName)
	if (exact) return exact
	const normalized = toolName.replace(/-/g, "_")
	return metadata.find((m) => m.name.replace(/-/g, "_") === normalized)
}

export function formatSchema(schema: unknown, indent = "  "): string {
	if (!schema || typeof schema !== "object") {
		return `${indent}(no schema)`
	}

	const s = schema as Record<string, unknown>

	if (s.type === "object" && s.properties && typeof s.properties === "object") {
		const props = s.properties as Record<string, unknown>
		const required = Array.isArray(s.required) ? (s.required as string[]) : []

		if (Object.keys(props).length === 0) {
			return `${indent}(no parameters)`
		}

		const lines: string[] = []
		for (const [name, propSchema] of Object.entries(props)) {
			const isRequired = required.includes(name)
			const propLine = formatProperty(name, propSchema, isRequired, indent)
			lines.push(propLine)
		}
		return lines.join("\n")
	}

	if (s.type) {
		return `${indent}(${s.type})`
	}

	return `${indent}(complex schema)`
}

function formatProperty(name: string, schema: unknown, required: boolean, indent: string): string {
	if (!schema || typeof schema !== "object") {
		return `${indent}${name}${required ? " *required*" : ""}`
	}

	const s = schema as Record<string, unknown>
	const parts: string[] = []

	let typeStr = ""
	if (s.type) {
		if (Array.isArray(s.type)) {
			typeStr = s.type.join(" | ")
		} else {
			typeStr = String(s.type)
		}
	} else if (s.enum) {
		typeStr = "enum"
	} else if (s.anyOf || s.oneOf) {
		typeStr = "union"
	}

	if (Array.isArray(s.enum)) {
		const enumVals = s.enum.map((v) => JSON.stringify(v)).join(", ")
		typeStr = `enum: ${enumVals}`
	}

	parts.push(`${indent}${name}`)
	if (typeStr) parts.push(`(${typeStr})`)
	if (required) parts.push("*required*")

	if (s.description && typeof s.description === "string") {
		parts.push(`- ${s.description}`)
	}

	if (s.default !== undefined) {
		parts.push(`[default: ${JSON.stringify(s.default)}]`)
	}

	return parts.join(" ")
}
