/**
 * MCP wire tool-name construction.
 *
 * Provider-side tool names must match ^[a-zA-Z0-9_-]{1,128}$ (Anthropic custom-tool
 * contract; violations come back as `tools.N.custom.name: String should match pattern
 * '^[a-zA-Z0-9_-]{1,128}$'` with HTTP 400). MCP server names are free-form user config
 * (e.g. "Atlassian Rovo") and server-provided tool names are arbitrary strings, so the
 * wire name must be sanitized here — otherwise every request carrying the tool fails
 * server-side validation and the turn dies.
 *
 * Sanitization can collapse distinct inputs onto one wire name (tools `get issue` and
 * `get_issue`, servers `foo bar` and `foo-bar`), and truncation drops everything past
 * 128 chars. Callers that register tools by wire name must detect such collisions —
 * see the `seenNames` guard in direct-tools.ts and the origin check in
 * registerAndActivate (index.ts).
 */

import { logger } from "./logger.js"

export const MAX_TOOL_NAME_LENGTH = 128

const INVALID_TOOL_NAME_CHAR = /[^a-zA-Z0-9_-]/g

function sanitizeNamePart(value: string): string {
	return value.replace(INVALID_TOOL_NAME_CHAR, "_")
}

/**
 * Get server prefix based on tool prefix mode.
 */
export function getServerPrefix(serverName: string, mode: "server" | "none" | "short"): string {
	if (mode === "none") return ""
	if (mode === "short") {
		let short = sanitizeNamePart(serverName.replace(/-?mcp$/i, "").replace(/-/g, "_"))
		if (!short) short = "mcp"
		return short
	}
	return sanitizeNamePart(serverName.replace(/-/g, "_"))
}

const warnedTruncatedNames = new Set<string>()

/**
 * Format a tool name with server prefix. The result always matches
 * ^[a-zA-Z0-9_-]{1,128}$: structurally valid names pass through byte-for-byte
 * (hyphens in the tool name are kept), anything else is replaced with "_".
 *
 * Overlong names are truncated — server prefix first, tool tail preserved so the
 * model can still reference the tool — with a warning once per distinct original
 * name. Keying on the original (not the truncated result) matters: two distinct
 * overlong names truncating to the same string is precisely a wire-name collision,
 * and each of them deserves its own warning.
 */
export function formatToolName(toolName: string, serverName: string, prefix: "server" | "none" | "short"): string {
	const toolPart = sanitizeNamePart(toolName) || "tool"
	const serverPrefix = getServerPrefix(serverName, prefix)
	const name = serverPrefix ? `${serverPrefix}_${toolPart}` : toolPart
	if (name.length <= MAX_TOOL_NAME_LENGTH) return name
	const limited =
		toolPart.length >= MAX_TOOL_NAME_LENGTH
			? toolPart.slice(0, MAX_TOOL_NAME_LENGTH)
			: `${name.slice(0, MAX_TOOL_NAME_LENGTH - toolPart.length - 1)}_${toolPart}`
	if (!warnedTruncatedNames.has(name)) {
		warnedTruncatedNames.add(name)
		logger.warn(
			`MCP: tool name "${name}" exceeds ${MAX_TOOL_NAME_LENGTH} chars; truncated to "${limited}" — may collide with similarly-named tools`,
			{ server: serverName, tool: toolName },
		)
	}
	return limited
}

function normalizeToolName(value: string): string {
	// Fuzzy matching for exclusions: hyphens and invalid characters all
	// normalize to "_" so user-written excludes match either the raw or the
	// sanitized wire form.
	return value.replace(/[^a-zA-Z0-9_]/g, "_")
}

export function isToolExcluded(
	toolName: string,
	serverName: string,
	prefix: "server" | "none" | "short",
	excludeTools?: unknown,
): boolean {
	if (!Array.isArray(excludeTools) || excludeTools.length === 0) return false

	const candidates = new Set<string>([
		normalizeToolName(toolName),
		normalizeToolName(formatToolName(toolName, serverName, prefix)),
		normalizeToolName(formatToolName(toolName, serverName, "server")),
		normalizeToolName(formatToolName(toolName, serverName, "short")),
	])

	for (const excluded of excludeTools) {
		if (typeof excluded !== "string") continue
		if (candidates.has(normalizeToolName(excluded))) {
			return true
		}
	}

	return false
}
