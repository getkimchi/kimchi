import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "../../resources/store.js"
import { FERMENT_V2_COMMAND_NAME, FERMENT_V2_RESOURCE_ID } from "./constants.js"

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
