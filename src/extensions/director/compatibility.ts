import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent"
import { getActiveFerment } from "../ferment/index.js"
import { isFermentV2OrchestrationActive } from "../ferment-v2/orchestration-state.js"
import { DirectorStore } from "./state.js"

/** Called by other orchestration runtimes before they claim a session's active slot. */
export function assertDirectorInactive(sessionManager: Pick<SessionManager, "getEntries">): void {
	const state = new DirectorStore({ sessionManager, appendEntry: () => undefined }).read()
	if (state && state.status !== "inactive")
		throw new Error("Director is active; stop or hand it off before starting another orchestration runtime")
}

export function createOrchestrationActivityProbe(pi: ExtensionAPI): () => boolean {
	return () => getActiveFerment() !== undefined || isFermentV2OrchestrationActive(pi)
}
