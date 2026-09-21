import { installAutoModelDiscoveryAdapter } from "./model-discovery.js"
import { installAutoSummarizationModelAdapter } from "./summarization-model.js"

/** Install all process-wide Pi adapters required by the Auto model. */
export function installAutoModelAdapters(): void {
	installAutoModelDiscoveryAdapter()
	installAutoSummarizationModelAdapter()
}
