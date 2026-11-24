// A non-MCP tool whose existing result details must not be confused with the
// MCP adapter's structured auth-start handoff metadata.
export default (pi) => {
	pi.registerTool({
		name: "test_manual_details",
		label: "Test manual details",
		description: "Return an unrelated tool's existing manual handoff detail.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({
			content: [{ type: "text", text: "unrelated-manual-result" }],
			details: { handoff: "manual", preserved: "yes" },
		}),
	})
}
