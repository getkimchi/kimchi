import {
	type DefaultProjectTrust,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent"

/**
 * Resolve project trust for a headless session (no UI to prompt with),
 * mirroring pi's own resolveProjectTrusted minus the interactive prompt and the
 * project_trust extension event:
 *
 * 1. A cwd with no trust-requiring project resources is trivially trusted
 *    (there is nothing project-scoped to gate).
 * 2. A decision persisted in <agentDir>/trust.json (from a previous interactive
 *    run's trust prompt) is honored.
 * 3. Otherwise the `defaultProjectTrust` setting decides: "always" trusts,
 *    "never" refuses, and "ask" — with no UI to ask — falls back to untrusted,
 *    exactly like pi's own no-UI path.
 *
 * `defaultProjectTrust` must come from a global-scope read (a manager created
 * with projectTrusted: false): a project must not be able to grant itself
 * trust through its own .pi/settings.json.
 */
export function resolveHeadlessProjectTrust(
	cwd: string,
	agentDir: string,
	defaultProjectTrust: DefaultProjectTrust | undefined,
): boolean {
	try {
		if (!hasTrustRequiringProjectResources(cwd)) return true
		const decision = new ProjectTrustStore(agentDir).get(cwd)
		if (decision !== null) return decision
		return defaultProjectTrust === "always"
	} catch {
		// Trust resolution must never take a session down; fail closed.
		return false
	}
}
