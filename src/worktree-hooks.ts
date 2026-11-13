/**
 * WorktreeCreate / WorktreeRemove command-hook emission (slice 3).
 *
 * Unlike the in-session hook paths (tool use, prompts, stops), worktree
 * lifecycle events fire from spots without a pi session — the pre-main
 * `--worktree` hook, the agent manager's settle step, the exit prompt, and
 * the `kimchi worktree` subcommands — so this module runs discovered hook
 * resources directly instead of going through an ExtensionAPI.
 *
 * Hooks are advisory here: their stdout/decision is ignored and failures are
 * swallowed. Project-scoped hooks only run when the caller asserts the
 * project is trusted (project config is privileged — fail closed).
 */

import { CLAUDE_CODE_HOOK_ADAPTER_DEFINITION } from "./extensions/claude-code-hook-adapter/definition.js"
import { runCommandHook } from "./extensions/hook-adapters/adapter.js"
import { type CommandHookResource, discoverCommandHookResources } from "./extensions/hook-adapters/discovery.js"
import { KIMCHI_HOOKS_ADAPTER_DEFINITION } from "./extensions/kimchi-hooks/definition.js"
import { PLUGIN_PACKAGE_HOOK_ADAPTER_DEFINITION } from "./extensions/plugin-package-hook-adapter/definition.js"

export type WorktreeHookEvent = "WorktreeCreate" | "WorktreeRemove"

export interface WorktreeHookSubject {
	/** Worktree directory name (basename under .kimchi/worktrees). */
	name: string
	/** Absolute worktree directory. */
	dir: string
	/** Branch name (`worktree-<name>`). */
	branch: string
	/** Main checkout root the worktree belongs to. */
	mainRoot: string
	/** user = --worktree / EnterWorktree / kimchi worktree; agent = subagent isolation. */
	kind: "user" | "agent"
}

/** Worktree dir as the hook's cwd. Hook discovery happens against mainRoot
 *  (where project config lives); hook processes run inside the worktree. */
function discoverWorktreeHooks(
	event: WorktreeHookEvent,
	mainRoot: string,
	projectTrusted: boolean,
): CommandHookResource[] {
	const definitions = [
		CLAUDE_CODE_HOOK_ADAPTER_DEFINITION,
		KIMCHI_HOOKS_ADAPTER_DEFINITION,
		PLUGIN_PACKAGE_HOOK_ADAPTER_DEFINITION,
	]
	const resources: CommandHookResource[] = []
	for (const definition of definitions) {
		let discovered: CommandHookResource[]
		try {
			discovered = discoverCommandHookResources(definition, mainRoot)
		} catch {
			continue // a broken hooks file must not break worktree lifecycle
		}
		for (const resource of discovered) {
			if (resource.eventName !== event) continue
			if (resource.scope !== "user" && !projectTrusted) continue
			resources.push(resource)
		}
	}
	return resources
}

/**
 * Fire worktree lifecycle hooks, best-effort. Never throws.
 *
 * @param event WorktreeCreate | WorktreeRemove
 * @param subject the worktree the event is about
 * @param projectTrusted whether project/local-scope hooks may run
 */
export async function emitWorktreeHook(
	event: WorktreeHookEvent,
	subject: WorktreeHookSubject,
	projectTrusted: boolean,
): Promise<void> {
	let resources: CommandHookResource[]
	try {
		resources = discoverWorktreeHooks(event, subject.mainRoot, projectTrusted)
	} catch {
		return
	}
	if (resources.length === 0) return

	const payload: Record<string, unknown> = {
		hook_event_name: event,
		cwd: subject.dir,
		worktree: {
			name: subject.name,
			dir: subject.dir,
			branch: subject.branch,
			main_root: subject.mainRoot,
			kind: subject.kind,
		},
	}
	for (const resource of resources) {
		try {
			await runCommandHook(resource, payload, subject.dir)
		} catch {
			// Advisory: a failing hook must not break worktree lifecycle.
		}
	}
}
