import { type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent"
import { resolveHeadlessProjectTrust } from "../../../project-trust.js"

/** Child setters and reloads must never write the user's settings files. */
export function createChildSettings(
	cwd: string,
	agentDir: string,
	parent: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
): SettingsManager {
	const source = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
	const projectTrusted =
		cwd === parent.cwd
			? parent.isProjectTrusted()
			: resolveHeadlessProjectTrust(cwd, agentDir, source.getDefaultProjectTrust())
	source.setProjectTrusted(projectTrusted)
	const loadErrors = source.drainErrors()
	const scopes = {
		global: JSON.stringify(source.getGlobalSettings()),
		project: JSON.stringify(source.getProjectSettings()),
	}
	return SettingsManager.fromStorage(
		{
			withLock(scope, update) {
				const loadError = loadErrors.find((entry) => entry.scope === scope)
				if (loadError) throw loadError.error
				const next = update(scopes[scope])
				if (next !== undefined) scopes[scope] = next
			},
		},
		{ projectTrusted },
	)
}
