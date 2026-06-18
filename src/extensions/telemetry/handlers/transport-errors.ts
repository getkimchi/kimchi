import type { SessionContext } from "../session-context.js"

const TRANSPORT_ERROR_PATTERNS = [
	"socket connection was closed unexpectedly",
	"socket closed",
	"connection closed",
	"connection reset",
	"broken pipe",
	"econnreset",
	"econnrefused",
]

function isTransportError(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false
	const lower = errorMessage.toLowerCase()
	return TRANSPORT_ERROR_PATTERNS.some((p) => lower.includes(p))
}

export function handleTransportError(
	ctx: SessionContext,
	event: {
		message: {
			role?: string
			model?: string
			provider?: string
			api?: string
			stopReason?: string
			errorMessage?: string
		}
	},
): void {
	const msg = event.message
	if (msg.role !== "assistant") return
	if (msg.stopReason !== "error") return
	if (!isTransportError(msg.errorMessage)) return

	ctx.emit("error", {
		model: msg.model ?? "unknown",
		error_type: "transport_error",
		error_message: (msg.errorMessage ?? "").slice(0, 300),
	})
}
