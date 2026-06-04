import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
	type CommandHookAdapterDefinition,
	type CommandHookSource,
	discoverCommandHookResources,
} from "../hook-adapters/discovery.js"

export const CLAUDE_CODE_HOOK_ADAPTER_DEFINITION: CommandHookAdapterDefinition = {
	id: "claude-code",
	label: "Claude Code",
	customType: "kimchi-claude-code-hook-context",
	supportedEvents: [
		"PreToolUse",
		"PostToolUse",
		"SessionStart",
		"PreCompact",
		"PostCompact",
		"UserPromptSubmit",
		"Stop",
		"SessionEnd",
	],
	sources: claudeCodeHookSources,
	defaultTimeoutMs: 60_000,
}

export function discoverClaudeCodeHookResources(cwd = process.cwd()) {
	return discoverCommandHookResources(CLAUDE_CODE_HOOK_ADAPTER_DEFINITION, cwd)
}

function claudeCodeHookSources(cwd = process.cwd()): CommandHookSource[] {
	const homeDir = homedir()
	const projectDir = resolve(cwd)
	if (!existsSync(join(projectDir, ".claude"))) return []
	const sources: CommandHookSource[] = [{ scope: "user", path: join(homeDir, ".claude", "settings.json") }]
	if (resolve(projectDir) !== resolve(homeDir)) {
		sources.push(
			{ scope: "project", path: join(projectDir, ".claude", "settings.json") },
			{ scope: "local", path: join(projectDir, ".claude", "settings.local.json") },
		)
	}
	return sources
}
