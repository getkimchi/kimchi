/**
 * TUI e2e fixture extension for the Codemode context estimate.
 *
 * Registers a tool with an outputSchema whose display text is short while its
 * structuredContent is large. Pi hands a Codemode script the structured value,
 * so the estimate must count it, not the display text.
 *
 * Deliberately import-free so the binary's jiti loader needs no module
 * resolution beyond this file.
 */

/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function structuredOutputToolExtension(pi) {
	pi.registerTool({
		name: "structured_report",
		label: "Structured report",
		description: "Return a report as structured data.",
		parameters: { type: "object", properties: {} },
		outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		execute: async () => ({
			content: [{ type: "text", text: "short" }],
			details: {},
			structuredContent: { text: "x".repeat(10_000) },
		}),
	})
}
