import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { resetSocketBreaker } from "../upstream-retry-patch.js"

/**
 * Reset half of the socket-error circuit breaker. Errored attempts are counted
 * where they are classified, in the patched retry classifier
 * (upstream-retry-patch.ts); this extension closes the breaker again on any
 * successful assistant message, mirroring upstream's reset-on-success rule so
 * recovered runs are never cut short by an earlier storm.
 */
export default function socketBreakerExtension(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const message = event.message
		if (message.role === "assistant" && message.stopReason !== "error") resetSocketBreaker()
	})
}
