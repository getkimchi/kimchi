export default function (pi) {
	pi.registerCommand("fork-test-select", {
		description: "Select the first assistant reply",
		handler: async (_args, ctx) => {
			const first = ctx.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "assistant")
			if (!first) throw new Error("No assistant reply to select")
			ctx.sessionManager.branch(first.id)
		},
	})
	pi.registerCommand("fork-test-compact", {
		description: "Compact the first turn",
		handler: async (_args, ctx) => {
			const turns = ctx.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
			if (turns.length < 2) throw new Error("Two turns required")
			ctx.sessionManager.appendCompaction("fixture compaction summary", turns[1].id, 1000)
		},
	})
}
