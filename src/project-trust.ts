import {
	type DefaultProjectTrust,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SettingsManager,
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

/**
 * Resolve project trust for the pre-main startup path — before pi's main()
 * resolves or prompts for it. Honors any persisted decision and the global
 * `defaultProjectTrust` setting (read from a global-scope manager so a
 * project cannot grant itself trust). With neither, resolves untrusted: the
 * interactive prompt inside pi's main() makes the real decision, and
 * settingsTrustSyncExtension syncs it onto the kimchi project-scope gate at
 * session_start.
 *
 * This exists because kimchi reads project-scoped config (endpoint, API key,
 * skill paths) before delegating to pi's main(); without this call a
 * previously trusted project's .kimchi/config.json would stay inert at every
 * startup, not just the first one.
 */
export function resolvePreMainProjectTrust(cwd: string, agentDir: string): boolean {
	try {
		const globalScope = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
		return resolveHeadlessProjectTrust(cwd, agentDir, globalScope.getDefaultProjectTrust())
	} catch {
		// Trust resolution must never take a session down; fail closed.
		return false
	}
}

/**
 * Pre-main trust resolution honoring pi's run-scoped trust overrides:
 * --no-approve forces untrusted (a persisted trust decision must not leak
 * project config into this run), --approve forces trusted, and otherwise the
 * persisted decision / defaultProjectTrust decides. Mirrors the explicitTrust
 * precedence in the MCP facade (src/extensions/mcp/index.ts).
 */
export function resolvePreMainProjectTrustWithOverrides(
	cwd: string,
	agentDir: string,
	trustOverride: boolean | undefined,
): boolean {
	if (trustOverride !== undefined) return trustOverride
	return resolvePreMainProjectTrust(cwd, agentDir)
}
