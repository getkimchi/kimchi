import { submitFinding, submitReply, submitSummary } from "./store.js"

interface FixtureCallMessage {
	request_id: number
	tool: "submit_finding" | "submit_summary" | "submit_reply"
	writer: string
	arguments: never
	fixed_created_at: string
}

// One long-lived instance of this file is spawned for each distinct `process`
// name in the vendored contract. It is deliberately not imported by production.
process.on("message", (message: FixtureCallMessage) => {
	void (async () => {
		try {
			process.env.REVIEW_WRITER = message.writer
			process.env.REVIEW_WRITER_LIMIT = "50"
			const context = {
				homeDir: process.env.HOME ?? "",
				writer: process.env.REVIEW_WRITER,
				writerLimit: Number(process.env.REVIEW_WRITER_LIMIT),
				now: () => new Date(message.fixed_created_at),
			}
			const submit =
				message.tool === "submit_finding"
					? submitFinding
					: message.tool === "submit_summary"
						? submitSummary
						: submitReply
			const result = await submit(message.arguments, context)
			process.send?.({ request_id: message.request_id, result })
		} catch (error) {
			process.send?.({
				request_id: message.request_id,
				error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			})
		}
	})()
})
