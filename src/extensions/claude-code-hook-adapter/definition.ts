import { homedir } from "node:os"
import { join } from "node:path"
import { findClaudeProjectDir } from "../claude-code/paths.js"
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
	const projectDir = findClaudeProjectDir(cwd)
	return [
		{ scope: "user", path: join(homedir(), ".claude", "settings.json") },
		{ scope: "project", path: join(projectDir, ".claude", "settings.json") },
		{ scope: "local", path: join(projectDir, ".claude", "settings.local.json") },
	]
}
