import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { resourceNotLoadedMessage } from "../../resources/not-loaded-message.js"
import { isResourceEnabled } from "../../resources/store.js"
import { FERMENT_V2_COMMAND_NAME, FERMENT_V2_RESOURCE_ID } from "./constants.js"

let fermentV2Loaded = false

export function markFermentV2Loaded(): void {
	fermentV2Loaded = true
}

// cli.ts loads V2 only at startup, so a later enable cannot register the command.
export function isFermentV2LoadedAndEnabled(): boolean {
	return fermentV2Loaded && isResourceEnabled(FERMENT_V2_RESOURCE_ID)
}

export function resetFermentV2LoadedForTests(): void {
	fermentV2Loaded = false
}

/**
 * Returns a check for UI that advertises `/ferment`, such as the startup logo.
 *
 * The command list is read once, when the check is created. cli.ts loads V2
 * only at startup, so the list cannot change later, and reading it on every
 * render would be wasted work. The setting is read on every call, so a
 * mid-session disable or an org FORCE_OFF refresh hides the hint at once.
 * Create the check after all extensions have loaded, for example in a
 * session_start handler.
 */
export function createFermentV2AvailabilityCheck(pi: ExtensionAPI): () => boolean {
	const loaded = pi
		.getCommands()
		.some((command) => command.name === FERMENT_V2_COMMAND_NAME && command.source === "extension")
	return () => loaded && isResourceEnabled(FERMENT_V2_RESOURCE_ID)
}

/** Why `/ferment` does nothing yet, and the fix. Says "restart" when the setting is on but V2 did not load. */
export function fermentNotLoadedMessage(subject: string): string {
	return resourceNotLoadedMessage(subject, FERMENT_V2_RESOURCE_ID, "Ferment")
}
