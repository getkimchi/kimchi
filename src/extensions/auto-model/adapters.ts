import { installAutoRoutingHeaderStrip } from "./request-headers.js"
import { installAutoSummarizationModelAdapter } from "./summarization-model.js"

/**
 * Install the process-wide Pi adapters still required by routed virtual
 * models:
 *
 * - Compaction and branch-summary calls get isolated request session IDs, so
 *   their request model must resolve from the owning AgentSession while the
 *   routing state is alive (summarization adapter).
 * - Requests for the virtual model must go out without the provider-pinning
 *   headers (X-Provider-Type / X-Provider-Name) its kimchi-dev block stamps
 *   carry, or the gateway scopes auto-routing to ai-enabler integrations
 *   only (request-header strip).
 */
export function installAutoModelAdapters(): void {
	installAutoSummarizationModelAdapter()
	installAutoRoutingHeaderStrip()
}
