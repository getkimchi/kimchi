/**
 * Request timing extension — captures per-LLM-call diagnostics.
 *
 * Hooks into `before_provider_request` / `after_provider_response` to
 * measure duration, and `turn_end` to persist timing + diagnostics
 * as a custom entry alongside the assistant message.
 *
 * This data is surfaced in `/export` output so that per-call
 * diagnostics (status, duration, retries, errors) are visible.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/** Shape of the `data` field on a `request_diagnostics` custom entry. */
export interface RequestDiagnosticsData {
	/** ISO timestamp when the request was sent */
	requestStartedAt: string
	/** ISO timestamp when the response was received */
	requestCompletedAt: string
	/** Wall-clock duration in milliseconds */
	durationMs: number
	/** HTTP status code from the provider response */
	status: number
	/** Trace ID from response headers, if available */
	traceId?: string
	/** Error message if the request failed */
	error?: string
	/** Whether this request was a retry */
	isRetry?: boolean
}

function getTraceId(headers: unknown): string | undefined {
	if (!headers || typeof headers !== "object") return undefined

	// Native fetch Headers objects expose .get() and .entries()
	const h = headers as {
		get?: (key: string) => string | null
		entries?: () => IterableIterator<[string, string]>
	}

	if (typeof h.get === "function") {
		const value = h.get("x-trace-id")
		if (typeof value === "string") return value
	}

	if (typeof h.entries === "function") {
		for (const [key, value] of h.entries()) {
			if (key.toLowerCase() === "x-trace-id" && typeof value === "string") {
				return value
			}
		}
		return undefined
	}

	// Fall back to plain object iteration
	for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
		if (key.toLowerCase() === "x-trace-id" && typeof value === "string") {
			return value
		}
	}

	return undefined
}

export default function requestTimingExtension(pi: ExtensionAPI): void {
	// Track timing per turn — a turn may have multiple provider calls (retries)
	let lastRequestTime: number | undefined
	let retryCount = 0
	let lastError: string | undefined

	pi.on("turn_start", async () => {
		retryCount = 0
		lastError = undefined
	})

	pi.on("before_provider_request", async () => {
		lastRequestTime = Date.now()
		lastError = undefined
	})

	pi.on("after_provider_response", async (event) => {
		if (lastRequestTime === undefined) return

		const completedAt = Date.now()
		const durationMs = completedAt - lastRequestTime

		// Extract trace ID from headers if available
		const traceId = getTraceId(event.headers)

		// Detect retries: if status >= 500 or status === 429, the SDK may retry
		const isRetry = retryCount > 0
		if (event.status >= 500 || event.status === 429) {
			retryCount++
		}

		const data: RequestDiagnosticsData = {
			requestStartedAt: new Date(lastRequestTime).toISOString(),
			requestCompletedAt: new Date(completedAt).toISOString(),
			durationMs,
			status: event.status,
			traceId,
			isRetry,
			error: lastError,
		}

		pi.appendEntry("request_diagnostics", data)

		// Reset for next call in the same turn
		lastRequestTime = undefined
	})

	// Track errors via message_end for failed responses
	pi.on("message_end", async (event) => {
		const msg = event.message as { stopReason?: string; errorMessage?: string }
		if (msg?.stopReason === "error" && msg.errorMessage) {
			lastError = msg.errorMessage
		}
	})
}
