import type { BoardPostReceipt, BoardReadReceipt } from "./manager/board.js"
import type { AgentMessageReceipt } from "./messages.js"

/** Minimal tool result with text content and empty details. */
export function textResult(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} }
}

/** Throw so Pi records failed execution while preserving the host's recovery details. */
export function agentMessageResult(receipt: AgentMessageReceipt) {
	const message = JSON.stringify(receipt)
	if (receipt.status === "rejected" || receipt.status === "unavailable" || receipt.status === "saturated") {
		throw new Error(message)
	}
	return textResult(message)
}

export function agentBoardResult(receipt: BoardPostReceipt | BoardReadReceipt) {
	const message = JSON.stringify(receipt)
	if (!receipt.ok) throw new Error(message)
	return textResult(message)
}
