/**
 * Plugin-package SessionStart hook adapter.
 *
 * Loads ONLY the SessionStart hooks from each enabled pi plugin package's
 * `hooks/hooks.json` (or `.claude-plugin/hooks/hooks.json`) and injects their
 * `additionalContext` into the system prompt on the first `before_agent_start`
 * event, giving a strong steering delivery.
 *
 * Tool capture and routing is intentionally left to each package's own pi
 * extension to avoid double-capturing PreToolUse/PostToolUse/etc.  This
 * adapter handles nothing except the SessionStart steering block.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { getConfiguredPackageResourceRecords } from "../../resources/package-resources.js"
import { getResourceOverride } from "../../resources/store.js"
import {
	type CommandHookAdapterDefinition,
	type CommandHookSource,
	discoverCommandHookResources,
} from "../hook-adapters/discovery.js"

export const PLUGIN_PACKAGE_HOOK_ADAPTER_DEFINITION: CommandHookAdapterDefinition = {
	id: "plugin-package",
	label: "Plugin package",
	customType: "kimchi-plugin-package-hook-context",
	supportedEvents: ["SessionStart"],
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
