import type { AgentSessionServices, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import {
	TeleportArgsError,
	parseAttachArgs,
	parseConnectArgs,
	parseDetachArgs,
	parseSyncArgs,
	parseTeleportArgs,
} from "../modes/teleport/commands/args.js"
import {
	TeleportRefusal,
	runAttach,
	runConnect,
	runDetach,
	runListSessions,
	runSync,
	runTeleport,
} from "../modes/teleport/commands/index.js"
import type { TeleportContext } from "../modes/teleport/commands/index.js"
import type { TeleportableAgentSession } from "../modes/teleport/proxy/teleportable-session.js"
import { setSessionIndicator } from "./ui.js"

export interface TeleportExtensionDeps {
	getWrapper: () => TeleportableAgentSession | undefined
	getServices: () => AgentSessionServices | undefined
	/**
	 * Lazy getter for the InteractiveMode rebind trigger captured in
	 * run-interactive-teleport.ts. We call this after `wrapper.foregroundRemote`
	 * / `detachToHomeBase` so the TUI re-binds to the swapped foreground;
	 * without it the prompt stays wired to the original session and input
	 * appears to do nothing.
	 */
	getTriggerRebind: () => (() => Promise<void>) | undefined
	/**
	 * Lazy getter for the "fresh UI" trigger captured in run-interactive-teleport.ts.
	 * Mirrors pi-mono's own post-`switchSession` sequence (`resetExtensionUI` +
	 * `renderCurrentSessionState`). The rebind alone re-attaches listeners and
	 * bindings but leaves the chat container and extension overlays from the
	 * previous foreground in place — that staleness manifests as "I can type
	 * but nothing happens" after `/teleport`.
	 */
	getTriggerFreshUI: () => (() => void) | undefined
	apiKey: string
	endpoint?: string
}

function buildCtx(ctx: ExtensionCommandContext, deps: TeleportExtensionDeps): TeleportContext | undefined {
	const wrapper = deps.getWrapper()
	const services = deps.getServices()
	if (!wrapper || !services) {
		if (ctx.hasUI) ctx.ui.notify("Teleport is not ready yet — try again in a moment.", "warning")
		return undefined
	}
	return {
		wrapper,
		services,
		apiKey: deps.apiKey,
		endpoint: deps.endpoint,
		cwd: ctx.cwd,
		ui: ctx.ui,
		signal: ctx.signal,
		triggerRebind: deps.getTriggerRebind(),
		triggerFreshUI: deps.getTriggerFreshUI(),
		onHostResolved: (host: string) => setSessionIndicator(formatSessionLabel(host)),
	}
}

function asString(args: unknown): string {
	return typeof args === "string" ? args : ""
}

function handleError(ctx: ExtensionCommandContext, err: unknown) {
	if (err instanceof TeleportRefusal) return
	if (err instanceof TeleportArgsError) {
		if (ctx.hasUI) ctx.ui.notify(err.message, "error")
		return
	}
	if (ctx.hasUI) ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
}

export function formatSessionLabel(host: string | undefined): string {
	if (!host) return "(remote)"
	const stripped = host.replace(/\.remote\.kimchi\.dev$/, "")
	return stripped ? `(${stripped})` : "(remote)"
}

export default function makeTeleportExtension(deps: TeleportExtensionDeps): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI): void => {
		pi.registerCommand("teleport", {
			description: "Spawn a new remote worker with the current workspace.",
			handler: async (args, ctx) => {
				const parsed = (() => {
					try {
						return parseTeleportArgs(asString(args))
					} catch (err) {
						handleError(ctx, err)
						return undefined
					}
				})()
				if (!parsed) return
				const tctx = buildCtx(ctx, deps)
				if (!tctx) return
				try {
					const result = await runTeleport(parsed, tctx)
					setSessionIndicator(formatSessionLabel(result.host))
				} catch (err) {
					handleError(ctx, err)
				}
			},
		})

		pi.registerCommand("detach", {
			description: "Disconnect from the foreground remote (server keeps it running).",
			handler: async (args, ctx) => {
				const parsed = (() => {
					try {
						return parseDetachArgs(asString(args))
					} catch (err) {
						handleError(ctx, err)
						return undefined
					}
				})()
				if (!parsed) return
				const tctx = buildCtx(ctx, deps)
				if (!tctx) return
				try {
					await runDetach(parsed, tctx)
					setSessionIndicator(null)
				} catch (err) {
					handleError(ctx, err)
				}
			},
		})

		pi.registerCommand("attach", {
			description: "Re-attach to a previously-detached remote by name or id.",
			handler: async (args, ctx) => {
				const parsed = (() => {
					try {
						return parseAttachArgs(asString(args))
					} catch (err) {
						handleError(ctx, err)
						return undefined
					}
				})()
				if (!parsed) return
				const tctx = buildCtx(ctx, deps)
				if (!tctx) return
				try {
					const result = await runAttach(parsed, tctx)
					setSessionIndicator(formatSessionLabel(result.host))
				} catch (err) {
					handleError(ctx, err)
				}
			},
		})

		pi.registerCommand("connect", {
			description: "Open an interactive ssh shell on the sandbox via the teleport proxy.",
			handler: async (args, ctx) => {
				const parsed = (() => {
					try {
						return parseConnectArgs(asString(args))
					} catch (err) {
						handleError(ctx, err)
						return undefined
					}
				})()
				if (!parsed) return
				const tctx = buildCtx(ctx, deps)
				if (!tctx) return
				try {
					await runConnect(parsed, tctx)
				} catch (err) {
					handleError(ctx, err)
				}
			},
		})

		pi.registerCommand("sessions", {
			description: "List remote sessions (foreground, detached in-process, and on the server).",
			handler: async (_args, ctx) => {
				const tctx = buildCtx(ctx, deps)
				if (!tctx) return
				try {
					await runListSessions(tctx)
				} catch (err) {
					handleError(ctx, err)
				}
			},
		})

		pi.registerCommand("sync", {
			description: "Rsync files between local and remote: /sync up [path] or /sync down [path].",
			handler: async (args, ctx) => {
				const parsed = (() => {
					try {
						return parseSyncArgs(asString(args))
					} catch (err) {
						handleError(ctx, err)
						return undefined
					}
				})()
				if (!parsed) return
				const tctx = buildCtx(ctx, deps)
				if (!tctx) return
				try {
					await runSync(parsed, tctx)
				} catch (err) {
					handleError(ctx, err)
				}
			},
		})
	}
}
