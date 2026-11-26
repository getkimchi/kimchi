import {
	describeOrgLock,
	getResourcePolicy,
	getResourcePolicySource,
	isResourceEnabled,
} from "../../resources/store.js"
import { FERMENT_LEGACY_RESOURCE_ID } from "./resource-id.js"

// Re-export the pure id constants so existing importers of resource.js keep
// working. They live in resource-id.js to break the definitions/store cycle.
export { FERMENT_LEGACY_COMMAND_NAME, FERMENT_LEGACY_RESOURCE_ID } from "./resource-id.js"

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
 * Returns undefined when legacy is on. An org lock cannot be lifted locally,
 * so that case names the policy entry instead of `kimchi resources enable`.
 */
export function fermentLegacyOffMessage(subject: string): string | undefined {
	if (isFermentLegacyEnabled()) return undefined
	const policy = getResourcePolicy(FERMENT_LEGACY_RESOURCE_ID)
	if (policy === "FORCE_OFF") {
		const source = getResourcePolicySource(FERMENT_LEGACY_RESOURCE_ID) ?? FERMENT_LEGACY_RESOURCE_ID
		return `${subject} needs the legacy Ferment, which your organization turned off (${source} is ${describeOrgLock(policy)}). Ask your organization admin to change the policy.`
	}
	return `${subject} needs the legacy Ferment, which is off. Turn it on with: kimchi resources enable ${FERMENT_LEGACY_RESOURCE_ID}`
}

function isFermentLegacyOrgLocked(): boolean {
	return getResourcePolicy(FERMENT_LEGACY_RESOURCE_ID) === "FORCE_OFF"
}

/**
 * For entry points that exist only when V1 loaded at startup, such as the
 * `/ferment-legacy` stub. A setting change needs a restart to load V1, so
 * every case the user can fix locally says so. An org lock cannot be fixed
 * locally, so a restart hint there would only mislead.
 */
export function fermentLegacyNotLoadedMessage(subject: string): string {
	const offMessage = fermentLegacyOffMessage(subject)
	if (offMessage === undefined) {
		return `${subject} needs the legacy Ferment. It is on now, but it loads only when kimchi starts. Restart kimchi to use it.`
	}
	if (isFermentLegacyOrgLocked()) return offMessage
	return `${offMessage}\nThen restart kimchi to load it.`
}
