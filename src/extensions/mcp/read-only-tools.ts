/**
 * Conservative fallback used while upstream does not expose MCP annotations
 * through its public tool-surface API. Explicit annotations will replace this
 * name heuristic once the public API carries them.
 */
const READ_ONLY_NAME_PREFIXES = /^(get|search|list|read|fetch)/

export function isReadOnlyMcpToolName(originalName: string): boolean {
	return READ_ONLY_NAME_PREFIXES.test(originalName)
}
