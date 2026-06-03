import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
	type CommandHookAdapterDefinition,
	type CommandHookSource,
	discoverCommandHookResources,
} from "../hook-adapters/discovery.js"

export const CODEX_HOOK_ADAPTER_DEFINITION: CommandHookAdapterDefinition = {
	id: "codex",
	label: "Codex",
	customType: "kimchi-codex-hook-context",
	supportedEvents: [
		"PreToolUse",
		"PostToolUse",
		"SessionStart",
		"PreCompact",
		"PostCompact",
		"UserPromptSubmit",
		"Stop",
	],
	sources: codexHookSources,
	defaultTimeoutMs: 600_000,
	skipAsyncHandlers: true,
}

export function discoverCodexHookResources(cwd = process.cwd()) {
	return discoverCommandHookResources(CODEX_HOOK_ADAPTER_DEFINITION, cwd)
}

function codexHookSources(cwd = process.cwd()): CommandHookSource[] {
	return [
		{ scope: "user", path: join(homedir(), ".codex", "hooks.json") },
		{ scope: "project", path: resolve(cwd, ".codex", "hooks.json") },
	]
}
