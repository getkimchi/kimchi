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

/** Bounded length for the upstream-host diagnostic attr. */
const MAX_HOST_LEN = 64

/**
 * Canonical transport-error families (error-telemetry canonicalization v1).
 *
 * The raw messages embed upstream hostnames and timeout values — one PostHog
 * series per distinct value — so recognized families collapse to a bounded
 * set with the diagnostics moved to explicitly selected bounded attrs.
 * Families are matched case-insensitively (the gate is). Unrecognized
 * transport errors keep the raw `slice(0, 300)` fail-open behavior, same
 * contract as the tool-error classifier — today every gate pattern maps to
 * a family, so that branch is defensive for future gate patterns.
 *
 * Match order is specific-first: the stream-idle message contains
 * "connection closed", so the generic family must not shadow it.
 */
function classifyTransportError(msg: string): { message: string; attrs?: Record<string, string | number> } {
	const idle = msg.match(/^Stream idle timeout: .*?no bytes received from (\S+) during body for (\d+)ms/)
	if (idle) {
		const host = idle[1]
		return {
			message: "Transport: stream idle timeout",
			attrs: {
				upstream_host: host.length > MAX_HOST_LEN ? host.slice(0, MAX_HOST_LEN) : host,
				idle_timeout_ms: Number(idle[2]),
			},
		}
	}
	const lower = msg.toLowerCase()
	if (lower.includes("socket connection was closed unexpectedly")) {
		return { message: "Transport: socket closed unexpectedly" }
	}
	if (lower.includes("econnrefused") || lower.includes("connection refused")) {
		return { message: "Transport: connection refused" }
	}
	if (lower.includes("econnreset") || lower.includes("connection reset")) {
		return { message: "Transport: connection reset" }
	}
	if (lower.includes("broken pipe")) {
		return { message: "Transport: broken pipe" }
	}
	if (lower.includes("socket closed") || lower.includes("connection closed")) {
		return { message: "Transport: connection closed" }
	}
	// Fail-open: unrecognized transport error keeps the raw head.
	return { message: msg.slice(0, 300) }
}

export function handleTransportError(
	tm: TelemetryContext,
	ctx: ExtensionContext,
	event: { message: AssistantMessage },
): void {
	const msg = event.message
	if (msg.stopReason !== "error") return
	if (!isTransportError(msg.errorMessage)) return

	const classification = classifyTransportError(msg.errorMessage ?? "")
	tm.emit(
		"error",
		{
			error_type: "transport_error",
			error_message: classification.message || "unknown transport error",
			canonicalization: "v1",
			...(classification.attrs ?? {}),
			...tm.getTraceAttributes(),
		},
		ctx,
	)
}
