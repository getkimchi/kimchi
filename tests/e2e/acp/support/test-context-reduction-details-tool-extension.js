// A non-codemode tool that already owns a `details.contextReduction` field.
// Codemode's internal estimate shares the name, so the ACP sanitizer must
// leave this tool's details untouched.
export default (pi) => {
	pi.registerTool({
		name: "test_context_reduction_details",
		label: "Test context reduction details",
		description: "Return an unrelated tool's own contextReduction detail.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({
			content: [{ type: "text", text: "unrelated-context-reduction-result" }],
			details: { contextReduction: { custom: "tool-owned value" }, requestId: "abc" },
		}),
	})
}
