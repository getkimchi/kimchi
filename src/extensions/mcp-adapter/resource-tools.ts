// resource-tools.ts - MCP resource name utilities

export function resourceNameToToolName(name: string): string {
	let result = name
		.replace(/[^a-zA-Z0-9]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+/, "") // Remove leading underscores
		.replace(/_+$/, "") // Remove trailing underscores
		.toLowerCase()

	// Ensure we have a valid name
	if (!result || /^\d/.test(result)) {
		result = `resource${result ? `_${result}` : ""}`
	}

	return result
}
