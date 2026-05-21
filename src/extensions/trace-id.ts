import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTraceId(headers: unknown): string | undefined {
	if (!headers || typeof headers !== "object") return undefined
	const h = headers as Record<string, unknown>
	if (typeof h.get === "function") {
		const val = (h as unknown as Headers).get("x-trace-id")
		if (val) return val
	}
	for (const [key, value] of Object.entries(h)) {
		if (key.toLowerCase() === "x-trace-id" && typeof value === "string" && value) {
			return value
		}
	}
	return undefined
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function traceIdExtension(pi: ExtensionAPI): void {
	let traceIds: string[] = []

	pi.on("turn_start", async () => {
		traceIds = []
	})

	pi.on("after_provider_response", async (event) => {
		const headers = event.headers
		if (!headers) return
		const traceId = extractTraceId(headers)
		if (traceId && !traceIds.includes(traceId)) {
			traceIds.push(traceId)
		}
	})

	pi.on("turn_end", async (event) => {
		if (traceIds.length === 0) return
		pi.appendEntry("trace_ids", { traceIds })
	})
}
