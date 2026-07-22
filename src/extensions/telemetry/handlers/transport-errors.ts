import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { TelemetryContext } from "../session-context.js"

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
	telemetry: TelemetryContext,
	ctx: ExtensionContext,
	event: { message: AssistantMessage },
): void {
	const msg = event.message
	if (msg.role !== "assistant") return
	if (msg.stopReason !== "error") return
	if (!isTransportError(msg.errorMessage)) return

	telemetry.emit(
		"error",
		{
			error_type: "transport_error",
			error_message: (msg.errorMessage ?? "").slice(0, 300),
		},
		ctx,
	)
}
