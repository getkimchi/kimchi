import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getResourceDefinition, getResourceDefinitions } from "./definitions.js"
import { isResourceEnabled, isResourceLocked, orgLockMessage, setResourceOverride } from "./store.js"
import type { ResourceKind } from "./types.js"
import { createResourceManager } from "./ui.js"

export default function resourcesExtension(pi: ExtensionAPI): void {
	pi.registerCommand("resources", {
		description: "View/change Kimchi hooks, tools, extensions, and plugins",
		handler: async (args, ctx) => {
			await handleResourcesCommand(args, ctx)
		},
	})

	pi.registerCommand("hooks", {
		description: "View/change Kimchi hooks",
		handler: async (_args, ctx) => {
			await openResourceKindMenu(ctx, "hooks")
		},
	})

	pi.registerCommand("plugins", {
		description: "View/change Kimchi plugins",
		handler: async (_args, ctx) => {
			await openResourceKindMenu(ctx, "plugins")
		},
	})
}

async function handleResourcesCommand(args: string, ctx: ExtensionContext): Promise<void> {
	const [sub, id, value] = args.trim().split(/\s+/).filter(Boolean)

	if (!sub) return openResourceMenu(ctx)
	if (sub === "list" || sub === "status") return showResourceStatus(ctx)
	if (sub === "enable" || sub === "disable") {
		if (!id) {
			ctx.ui.notify(`usage: /resources ${sub} <resource-id>`, "warning")
			return
		}
		if (refuseOrgLocked(id, ctx)) return
		const enabled = sub === "enable"
		setResourceOverride(id, enabled)
		ctx.ui.notify(`${id}: ${enabled ? "enabled" : "disabled"}${restartSuffix(id)}`, "info")
		return
	}
	if (sub === "set") {
		if (!id || !value || !["on", "off", "true", "false", "1", "0"].includes(value)) {
			ctx.ui.notify("usage: /resources set <resource-id> on|off", "warning")
			return
		}
		if (refuseOrgLocked(id, ctx)) return
		const enabled = value === "on" || value === "true" || value === "1"
		setResourceOverride(id, enabled)
		ctx.ui.notify(`${id}: ${enabled ? "enabled" : "disabled"}${restartSuffix(id)}`, "info")
		return
	}

	ctx.ui.notify(`resources: unknown subcommand "${sub}". Try /resources list.`, "warning")
}

async function openResourceMenu(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return showResourceStatus(ctx)

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => createResourceManager(tui, theme, done))
}

async function openResourceKindMenu(ctx: ExtensionContext, kind: ResourceKind): Promise<void> {
	if (ctx.mode !== "tui") return showResourceStatus(ctx)

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => createResourceManager(tui, theme, done, kind))
}

function showResourceStatus(ctx: ExtensionContext): void {
	const lines = getResourceDefinitions().map((resource) => {
		const status = isResourceEnabled(resource.id) ? "enabled " : "disabled"
		const lock = isResourceLocked(resource.id) ? " [org-locked]" : ""
		return `${status}  ${resource.id}${lock}  ${resource.description}`
	})
	ctx.ui.notify(lines.join("\n"), "info")
}

/** Warn and refuse when the resource is locked by the organization policy. */
function refuseOrgLocked(id: string, ctx: ExtensionContext): boolean {
	if (!isResourceLocked(id)) return false
	ctx.ui.notify(orgLockMessage(id), "warning")
	return true
}

function restartSuffix(id: string): string {
	return getResourceDefinition(id)?.restartRequired ? " (restart required)" : ""
}
