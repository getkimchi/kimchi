import { installAutoSummarizationModelAdapter } from "./summarization-model.js"

/**
 * Install the process-wide Pi adapter still required by routed virtual models:
 * compaction and branch-summary calls get isolated request session IDs, so
 * their request model must resolve from the owning AgentSession while the
 * routing state is alive.
 */
export function installAutoModelAdapters(): void {
	installAutoSummarizationModelAdapter()
}
