import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { isProjectScopeAllowed } from "../../project-scope-trust.js"
import {
	type CommandHookAdapterDefinition,
	type CommandHookSource,
	discoverCommandHookResources,
	FULL_COMMAND_HOOK_EVENTS,
} from "../hook-adapters/discovery.js"

export const CLAUDE_CODE_HOOK_ADAPTER_DEFINITION: CommandHookAdapterDefinition = {
	id: "claude-code",
	label: "Claude Code",
	customType: "kimchi-claude-code-hook-context",
	supportedEvents: FULL_COMMAND_HOOK_EVENTS,
	sources: claudeCodeHookSources,
	defaultTimeoutMs: 60_000,
}

export function discoverClaudeCodeHookResources(cwd = process.cwd()) {
	return discoverCommandHookResources(CLAUDE_CODE_HOOK_ADAPTER_DEFINITION, cwd)
}

function claudeCodeHookSources(cwd = process.cwd()): CommandHookSource[] {
	const homeDir = homedir()
	const projectDir = resolve(cwd)
	const sources: CommandHookSource[] = [{ scope: "user", path: join(homeDir, ".claude", "settings.json") }]
	// Project and local .claude settings are gated on project trust: an
	// untrusted repo must not ship hooks that kimchi lists (or, once enabled,
	// executes).
	if (
		existsSync(join(projectDir, ".claude")) &&
		resolve(projectDir) !== resolve(homeDir) &&
		isProjectScopeAllowed(cwd)
	) {
		sources.push(
			{ scope: "project", path: join(projectDir, ".claude", "settings.json") },
			{ scope: "local", path: join(projectDir, ".claude", "settings.local.json") },
		)
	}
	return sources
}
