/**
 * ACP E2E fixture extension registering custom tools whose results exceed the
 * 64 KiB externalization threshold (both plain text and outputSchema-backed
 * structuredContent).
 *
 * Deliberately import-free so the binary's jiti loader needs no module
 * resolution beyond this file.
 */

export default function largeNestedToolExtension(pi) {
	const text = Array.from(
		{ length: 4000 },
		(_, index) => `${index % 2 === 0 ? "alpha" : "beta"} ${String(index).padStart(5, "0")} large tool output line`,
	).join("\n")

	pi.registerTool({
		name: "big_text",
		label: "Big text",
		description: "Return a large text result.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text }], details: {} }),
	})

	pi.registerTool({
		name: "big_structured",
		label: "Big structured",
		description: "Return a large structured result.",
		parameters: { type: "object", properties: {} },
		outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		execute: async () => ({
			content: [{ type: "text", text }],
			details: {},
			structuredContent: { text },
		}),
	})
}
