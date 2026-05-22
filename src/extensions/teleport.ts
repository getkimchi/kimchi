import type {
	AgentSession,
	AgentSessionServices,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import {
	TeleportArgsError,
	parseAttachArgs,
	parseConnectArgs,
	parseSyncArgs,
	parseTeleportArgs,
} from "../modes/teleport/commands/args.js"
import {
	TeleportRefusal,
	runAttach,
	runConnect,
	runListSessions,
	runSync,
	runTeleport,
} from "../modes/teleport/commands/index.js"
import type { TeleportContext } from "../modes/teleport/commands/index.js"

export interface TeleportExtensionDeps {
	getSession: () => AgentSession | undefined
	getServices: () => AgentSessionServices | undefined
	apiKey: string
	endpoint?: string
}

/** Shared mutable state for the teleport extension within a single CLI run. */
const sharedState = {
	gitCredentialsSynced: new Set<string>(),
	lastSessionId: undefined as string | undefined,
}

function buildCtx(ctx: ExtensionCommandContext, deps: TeleportExtensionDeps): TeleportContext | undefined {
	const session = deps.getSession()
	const services = deps.getServices()
	if (!session || !services) {
		if (ctx.hasUI) ctx.ui.notify("Teleport is not ready yet — try again in a moment.", "warning")
		return undefined
	}
	return {
		session,
		services,
		apiKey: deps.apiKey,
		endpoint: deps.endpoint,
		cwd: ctx.cwd,
		ui: ctx.ui,
		signal: ctx.signal,
		gitCredentialsSynced: sharedState.gitCredentialsSynced,
		lastSessionId: sharedState.lastSessionId,
	}
}

function syncBackState(tctx: TeleportContext): void {
	sharedState.lastSessionId = tctx.lastSessionId
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
				} finally {
					syncBackState(tctx)
				}
			},
		})

		pi.registerCommand("attach", {
			description: "Attach to a remote session via SSH+tmux by name or id.",
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
				} finally {
					syncBackState(tctx)
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
			description: "List remote sessions.",
			handler: async (_args, ctx) => {
				const tctx = buildCtx(ctx, deps)
				if (!tctx) return
				try {
					await runListSessions(tctx)
				} catch (err) {
					handleError(ctx, err)
				} finally {
					syncBackState(tctx)
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
