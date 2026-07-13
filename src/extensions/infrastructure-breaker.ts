import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isInfrastructureProviderError } from "../infrastructure-error.js"
import { recordInfrastructureBreakerFailure, resetInfrastructureBreaker } from "../upstream-retry-patch.js"

/**
 * Counts infrastructure-classified assistant errors once per message_end and
 * closes the breaker again on any successful assistant message or non-infra
 * provider verdict.
 */
export default function infrastructureBreakerExtension(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const message = event.message
		if (message.role !== "assistant") return
		if (message.stopReason !== "error") {
			resetInfrastructureBreaker()
			return
		}
		if (typeof message.errorMessage === "string" && isInfrastructureProviderError(message.errorMessage)) {
			recordInfrastructureBreakerFailure()
		} else {
			resetInfrastructureBreaker()
		}
	})
}
