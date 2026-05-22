import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getResourceDefinition, getResourceDefinitions } from "./definitions.js"
import {
	ensureRtkPath,
	installRtk,
	isRtkCommandAvailable,
	isRtkInstalled,
	markRtkAutoInstallChecked,
	shouldCheckRtkAutoInstall,
} from "./rtk-install.js"
import { isResourceEnabled, setResourceOverride } from "./store.js"
import type { ResourceKind } from "./types.js"
import { createResourceManager } from "./ui.js"

export default function resourcesExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		void ensureRtkOnStartup(ctx)
	})

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
}

async function ensureRtkOnStartup(ctx: ExtensionContext): Promise<void> {
	if (!isResourceEnabled("hooks.rtk-rewrite")) return
	if (process.env.KIMCHI_RTK_AUTO_INSTALL === "0") return

	ensureRtkPath()
	const missing = !isRtkInstalled()
	const commandMissing = !isRtkCommandAvailable()
	if (!missing && !commandMissing && !shouldCheckRtkAutoInstall()) return

	try {
		const result = await installRtk()
		markRtkAutoInstallChecked()
		if ((missing || commandMissing) && ctx.hasUI) ctx.ui.notify(`RTK ready at ${result.linkPath}`, "info")
	} catch (err) {
		markRtkAutoInstallChecked()
		if ((missing || commandMissing) && ctx.hasUI)
			ctx.ui.notify(`RTK install failed: ${(err as Error).message}`, "warning")
	}
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
		const enabled = value === "on" || value === "true" || value === "1"
		setResourceOverride(id, enabled)
		ctx.ui.notify(`${id}: ${enabled ? "enabled" : "disabled"}${restartSuffix(id)}`, "info")
		return
	}

	ctx.ui.notify(`resources: unknown subcommand "${sub}". Try /resources list.`, "warning")
}

async function openResourceMenu(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return showResourceStatus(ctx)

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => createResourceManager(tui, theme, done))
}

async function openResourceKindMenu(ctx: ExtensionContext, kind: ResourceKind): Promise<void> {
	if (!ctx.hasUI) return showResourceStatus(ctx)

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => createResourceManager(tui, theme, done, kind))
}

function showResourceStatus(ctx: ExtensionContext): void {
	const lines = getResourceDefinitions().map((resource) => {
		const status = isResourceEnabled(resource.id) ? "enabled " : "disabled"
		return `${status}  ${resource.id}  ${resource.description}`
	})
	ctx.ui.notify(lines.join("\n"), "info")
}

function restartSuffix(id: string): string {
	return getResourceDefinition(id)?.restartRequired ? " (restart required)" : ""
}
