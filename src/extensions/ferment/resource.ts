import { resourceNotLoadedMessage, resourceOffMessage } from "../../resources/not-loaded-message.js"
import { isResourceEnabled } from "../../resources/store.js"
import { FERMENT_LEGACY_RESOURCE_ID } from "./resource-id.js"

/**
 * Legacy entry points call this so V1 stays inert unless the user opted in.
 * An org FORCE_OFF on `extensions.ferment` also counts here, through the
 * definition's `inheritsOrgForceOffFrom`, unless legacy has its own policy.
 */
export function isFermentLegacyEnabled(): boolean {
	return isResourceEnabled(FERMENT_LEGACY_RESOURCE_ID)
}

// cli.ts decides once at startup whether to load V1. A later /resources
// toggle changes the setting but cannot load or unload the extension.
let fermentLegacyLoaded = false

/** The V1 extension factory calls this when it runs. */
export function markFermentLegacyLoaded(): void {
	fermentLegacyLoaded = true
}

/**
 * Gate for V1 entry points that run after startup, such as the plan-review
 * option and the V1 tips. The live setting alone is not enough: turning
 * legacy on mid-session does not register V1 tools or its scheduler. The
 * setting still counts, so turning legacy off (or an org FORCE_OFF refresh)
 * hides V1 at once.
 */
export function isFermentLegacyLoadedAndEnabled(): boolean {
	return fermentLegacyLoaded && isFermentLegacyEnabled()
}

export function resetFermentLegacyLoadedForTests(): void {
	fermentLegacyLoaded = false
}

/**
 * The one text that tells a user why legacy Ferment is off and what to do.
 * `subject` names what needed it, such as `--ferment-oneshot` or a command.
 * Returns undefined when legacy is on.
 */
export function fermentLegacyOffMessage(subject: string): string | undefined {
	return resourceOffMessage(subject, FERMENT_LEGACY_RESOURCE_ID, "the legacy Ferment")
}

/** For entry points that exist only when V1 loaded at startup, such as the `/ferment-legacy` stub. */
export function fermentLegacyNotLoadedMessage(subject: string): string {
	return resourceNotLoadedMessage(subject, FERMENT_LEGACY_RESOURCE_ID, "the legacy Ferment")
}
