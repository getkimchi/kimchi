import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isInfrastructureProviderError } from "../infrastructure-error.js"
import { resetInfrastructureBreaker } from "../upstream-retry-patch.js"

/**
 * Reset half of the infrastructure-error circuit breaker. Errored attempts are counted
 * where they are classified, in the patched retry classifier
 * (upstream-retry-patch.ts); this extension closes the breaker again on any
 * successful assistant message or non-infra provider verdict.
 */
export default function infrastructureBreakerExtension(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const message = event.message
		if (message.role !== "assistant") return
		if (message.stopReason !== "error") {
			resetInfrastructureBreaker()
			return
		}
		if (typeof message.errorMessage !== "string" || !isInfrastructureProviderError(message.errorMessage)) {
			resetInfrastructureBreaker()
		}
	})
}
