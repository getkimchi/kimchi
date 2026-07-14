import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import {
	type CommandHookAdapterDefinition,
	type CommandHookSource,
	FULL_COMMAND_HOOK_EVENTS,
	discoverCommandHookResources,
} from "../hook-adapters/discovery.js"

export const KIMCHI_HOOKS_ADAPTER_DEFINITION: CommandHookAdapterDefinition = {
	id: "kimchi-hooks",
	label: "Kimchi hooks",
	customType: "kimchi-native-hook-context",
	supportedEvents: FULL_COMMAND_HOOK_EVENTS,
	sources: kimchiHookSources,
	defaultTimeoutMs: 60_000,
	sessionStartDelivery: "systemPrompt",
}

export function discoverKimchiHookResources(cwd = process.cwd()) {
	return discoverCommandHookResources(KIMCHI_HOOKS_ADAPTER_DEFINITION, cwd)
}

function kimchiHookSources(cwd = process.cwd()): CommandHookSource[] {
	const projectDir = resolve(cwd)
	if (!existsSync(join(projectDir, ".kimchi"))) return []
	const sources: CommandHookSource[] = []
	const projectHooks = join(projectDir, ".kimchi", "hooks.json")
	const localHooks = join(projectDir, ".kimchi", "hooks.local.json")
	if (existsSync(projectHooks)) sources.push({ scope: "project", path: projectHooks })
	if (existsSync(localHooks)) sources.push({ scope: "local", path: localHooks })
	return sources
}
