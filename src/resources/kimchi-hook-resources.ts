import type { CommandHookResource, HookAdapterScope } from "../extensions/hook-adapters/discovery.js"
import { discoverKimchiHookResources } from "../extensions/kimchi-hooks/definition.js"
import type { ResourceDefinition } from "./types.js"

/**
 * Kimchi-native hooks (.kimchi/hooks.json, hooks.local.json) as resource
 * definitions. Registration keeps the adapter's default-enabled execution
 * behavior while making the hooks visible and toggleable in /resources —
 * previously their ids were unregistered, so isResourceEnabled silently fell
 * back to enabled with no UI to manage them.
 *
 * Discovery itself is gated on project trust (see kimchi-hook sources in the
 * adapter definition): an untrusted repo's hooks are neither listed nor
 * executed.
 */
export function discoverKimchiHookResourceDefinitions(cwd = process.cwd()): ResourceDefinition[] {
	return discoverKimchiHookResources(cwd).map((hook) => ({
		id: hook.id,
		kind: "hooks",
		label: kimchiHookLabel(hook),
		description: kimchiHookDescription(hook),
		defaultEnabled: true,
	}))
}

function kimchiHookLabel(hook: CommandHookResource): string {
	const suffix = hook.matcher ? ` ${hook.matcher}` : ` #${hook.index}`
	return `Kimchi: ${hook.eventName}${suffix}`
}

function kimchiHookDescription(hook: CommandHookResource): string {
	const matcher = hook.matcher ? ` Matcher: ${hook.matcher}.` : ""
	const async = hook.async ? " Runs asynchronously." : ""
	return `${scopeLabel(hook.scope)} Kimchi-native ${hook.eventName} hook from ${hook.path}.${matcher}${async}`
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
