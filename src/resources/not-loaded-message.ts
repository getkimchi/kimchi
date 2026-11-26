import { describeOrgLock, getResourcePolicy, getResourcePolicySource, isResourceEnabled } from "./store.js"

/**
 * The one text that tells a user why a resource-gated feature is off and what
 * to do. `subject` names what needed it, such as a flag or a command.
 * Returns undefined when the resource is on. An org lock cannot be lifted
 * locally, so that case names the policy entry instead of
 * `kimchi resources enable`.
 */
export function resourceOffMessage(subject: string, resourceId: string, featureName: string): string | undefined {
	if (isResourceEnabled(resourceId)) return undefined
	const policy = getResourcePolicy(resourceId)
	if (policy === "FORCE_OFF") {
		const source = getResourcePolicySource(resourceId) ?? resourceId
		return `${subject} needs ${featureName}, which your organization turned off (${source} is ${describeOrgLock(policy)}). Ask your organization admin to change the policy.`
	}
	return `${subject} needs ${featureName}, which is off. Turn it on with: kimchi resources enable ${resourceId}`
}

/**
 * For entry points that exist only when the extension loaded at startup. A
 * setting change needs a restart to load it, so every case the user can fix
 * locally says so. An org lock cannot be fixed locally, so a restart hint
 * there would only mislead.
 */
export function resourceNotLoadedMessage(subject: string, resourceId: string, featureName: string): string {
	const offMessage = resourceOffMessage(subject, resourceId, featureName)
	if (offMessage === undefined) {
		return `${subject} needs ${featureName}. It is on now, but it loads only when kimchi starts. Restart kimchi to use it.`
	}
	if (getResourcePolicy(resourceId) === "FORCE_OFF") return offMessage
	return `${offMessage}\nThen restart kimchi to load it.`
}
