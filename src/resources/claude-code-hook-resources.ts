// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { discoverClaudeCodeHookResources } from "../extensions/claude-code-hook-adapter/definition.js"
import type { CommandHookResource, HookAdapterScope } from "../extensions/hook-adapters/discovery.js"
import type { ResourceDefinition } from "./types.js"

export function discoverClaudeCodeHookResourceDefinitions(cwd = process.cwd()): ResourceDefinition[] {
	return discoverClaudeCodeHookResources(cwd).map((hook) => ({
		id: hook.id,
		kind: "hooks",
		label: claudeCodeHookLabel(hook),
		description: claudeCodeHookDescription(hook),
		defaultEnabled: true,
	}))
}

function claudeCodeHookLabel(hook: CommandHookResource): string {
	const suffix = hook.matcher ? ` ${hook.matcher}` : ` #${hook.index}`
	return `Claude Code: ${hook.eventName}${suffix}`
}

function claudeCodeHookDescription(hook: CommandHookResource): string {
	const matcher = hook.matcher ? ` Matcher: ${hook.matcher}.` : ""
	const async = hook.async ? " Runs asynchronously." : ""
	return `${scopeLabel(hook.scope)} Claude Code ${hook.eventName} hook from ${hook.path}.${matcher}${async}`
}

function scopeLabel(scope: HookAdapterScope): string {
	switch (scope) {
		case "user":
			return "User"
		case "project":
			return "Project"
		case "local":
			return "Local project"
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker

export const DUMB_TEST_MARKER_LLM_4329 = "llm-4329-dumb-test-marker"
