import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const statuses = new WeakMap<ExtensionAPI, string>()

/** Track the current runtime's status without exposing its mutable Ferment object. */
export function setFermentV2OrchestrationStatus(pi: ExtensionAPI, status: string | undefined): void {
	if (status === "active" || status === "paused") statuses.set(pi, status)
	else statuses.delete(pi)
}

export function isFermentV2OrchestrationActive(pi: ExtensionAPI): boolean {
	return statuses.has(pi)
}
