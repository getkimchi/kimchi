import type { ProviderHeaders } from "@earendil-works/pi-ai"

export const TELEMETRY_PROVIDER_HEADER_NAMES = {
	sessionId: "X-Session-Id",
	conversationId: "X-Conversation-Id",
	turnIndex: "X-Turn-Index",
	parentSessionId: "X-Parent-Session-Id",
	traceparent: "traceparent",
} as const

const CANONICAL_HEADER_NAMES = new Map(
	Object.values(TELEMETRY_PROVIDER_HEADER_NAMES).map((name) => [name.toLowerCase(), name]),
)

/** Copy only Kimchi's telemetry correlation headers from an assembled provider request. */
export function selectTelemetryProviderHeaders(headers: ProviderHeaders | undefined): Record<string, string> {
	const selected: Record<string, string> = {}
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (value === null) continue
		const canonicalName = CANONICAL_HEADER_NAMES.get(name.toLowerCase())
		if (canonicalName) selected[canonicalName] = value
	}
	return selected
}
