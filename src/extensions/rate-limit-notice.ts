import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { formatLocalTime, formatWait, parseRateLimitRetryAt } from "../llm-gateway-error.js"
import { RATE_LIMIT_MAX_WAIT_MS, rememberRateLimitDeadline } from "../upstream-retry-patch.js"
import { getRawErrorMessage } from "./error-preservation.js"

export function rateLimitNotice(retryAt: number, model?: string, now: number = Date.now()): string {
	const subject = model ? `${model} is` : "Requests are"
	const waitMs = retryAt - now
	const until = `${subject} rate limited until ${formatLocalTime(retryAt)} (${formatWait(waitMs)})`
	// Past the bound the retry classifier refuses outright, so this is the one outcome decidable
	// here. Below it, whether a retry happens at all is settled later — upstream's countdown
	// reports the real wait, so do not pre-announce one.
	if (waitMs > RATE_LIMIT_MAX_WAIT_MS) {
		return `${until} — not retrying. Switch model with /model, or top up at https://app.kimchi.dev/billing`
	}
	return `${until}.`
}

/**
 * Restates a rate-limit deadline in local time, in place of the gateway's UTC wording. Registered
 * last so earlier extensions — classification, telemetry, diagnostics — still see the raw message;
 * interactive-error-surface has already swapped in its "Retrying…" placeholder by now, so the
 * deadline is parsed from the preserved original and the notice replaces the placeholder.
 */
export default function rateLimitNoticeExtension(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const message = event.message
		if (message.role !== "assistant" || message.stopReason !== "error") return

		const rawMessage = getRawErrorMessage(message)
		if (typeof rawMessage !== "string") return

		const retryAt = parseRateLimitRetryAt(rawMessage)
		if (retryAt === undefined) return

		// The retry policy reads the deadline off this same message after the rewrite, and local time
		// does not parse back. `_replaceMessageInPlace` mutates the original object, so keying on it holds.
		rememberRateLimitDeadline(message, retryAt)
		return { message: { ...message, errorMessage: rateLimitNotice(retryAt, message.model) } }
	})
}
