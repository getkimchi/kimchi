/**
 * Plugin-package hook adapter.
 *
 * Loads the `hooks/hooks.json` (or `.claude-plugin/hooks/hooks.json`) from
 * each enabled pi plugin package and honors the full Claude Code hook
 * lifecycle — the same event set as the standalone claude-code-hook-adapter.
 * SessionStart `additionalContext` is injected into the system prompt on the
 * first `before_agent_start` event, giving a strong steering delivery.
 *
 * Hooks run unconditionally alongside any pi extension the package ships:
 * extension event subscriptions are opaque, so no precedence check is
 * possible. Avoiding duplicate behavior across a package's hooks.json and
 * its pi extension is the package author's contract.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { getConfiguredPackageResourceRecords } from "../../resources/package-resources.js"
import { getResourceOverride } from "../../resources/store.js"
import {
	type CommandHookAdapterDefinition,
	type CommandHookSource,
	FULL_COMMAND_HOOK_EVENTS,
	discoverCommandHookResources,
} from "../hook-adapters/discovery.js"

export const PLUGIN_PACKAGE_HOOK_ADAPTER_DEFINITION: CommandHookAdapterDefinition = {
	id: "plugin-package",
	label: "Plugin package",
	customType: "kimchi-plugin-package-hook-context",
	supportedEvents: FULL_COMMAND_HOOK_EVENTS,
	sources: pluginPackageHookSources,
	defaultTimeoutMs: 60_000,
	sessionStartDelivery: "systemPrompt",
}

export function discoverPluginPackageHookResources(cwd = process.cwd()) {
	return discoverCommandHookResources(PLUGIN_PACKAGE_HOOK_ADAPTER_DEFINITION, cwd)
}

function pluginPackageHookSources(cwd = process.cwd()): CommandHookSource[] {
	const sources: CommandHookSource[] = []
	for (const record of getConfiguredPackageResourceRecords(cwd)) {
		if (!record.installedPath) continue
		// Use getResourceOverride (not isResourceEnabled) to avoid recursion when
		// dynamic resource definitions are being resolved.
		if (getResourceOverride(record.id) === false) continue
		const hooksFile = findPackageHooksFile(record.installedPath)
		if (!hooksFile) continue
		sources.push({ scope: "user", path: hooksFile, pluginRoot: record.installedPath })
	}
	return sources
}

function findPackageHooksFile(installedPath: string): string | undefined {
	const candidates = [
		join(installedPath, "hooks", "hooks.json"),
		join(installedPath, ".claude-plugin", "hooks", "hooks.json"),
	]
	return candidates.find((p) => existsSync(p))
}
