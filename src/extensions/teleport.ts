import type { AgentSessionServices, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import {
	TeleportArgsError,
	parseAttachArgs,
	parseConnectArgs,
	parseDetachArgs,
	parseTeleportArgs,
} from "../modes/teleport/args.js"
import {
	TeleportRefusal,
	runAttach,
	runConnect,
	runDetach,
	runListSessions,
	runTeleport,
} from "../modes/teleport/teleport.js"
import type { TeleportContext } from "../modes/teleport/teleport.js"
import type { TeleportableAgentSession } from "../modes/teleport/teleportable-agent-session.js"

export interface TeleportExtensionDeps {
	getWrapper: () => TeleportableAgentSession | undefined
	getServices: () => AgentSessionServices | undefined
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
					await runTeleport(parsed, tctx)
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
					await runAttach(parsed, tctx)
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
	}
}
