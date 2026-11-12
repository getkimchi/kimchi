import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../../cli-args.js"
import { formatPRWatchStatus, runPRWatchCommand } from "./command.js"
import { PRMonitor } from "./monitor.js"

const monitors = new WeakMap<object, PRMonitor>()

export function getPRMonitor(sessionManager: object): PRMonitor | undefined {
	return monitors.get(sessionManager)
}

export default function prMonitorExtension(pi: ExtensionAPI): void {
	let monitor: PRMonitor | undefined
	pi.registerFlag("pr-watch", {
		type: "boolean",
		default: false,
		description: "Watch this session's PR without granting automatic fixes.",
	})
	pi.on("session_start", async (_event, ctx) => {
		await monitor?.dispose()
		monitor = new PRMonitor(pi, ctx)
		if (ctx.mode === "tui")
			monitor.setNotify((state) => {
				ctx.ui.setStatus("pr-watch", state.enabled ? `PR watch: ${state.phase}` : undefined)
			})
		monitors.set(ctx.sessionManager, monitor)
		const prior = ctx.sessionManager
			.getEntries()
			.some((entry) => entry.type === "custom" && entry.customType === "pr_monitor")
		if (getParsedCliArgs().options["pr-watch"] === true && !prior) await monitor.configure(true, false)
	})
	pi.registerCommand("pr-watch", {
		description: "Watch this PR locally and fix CI or review feedback: /pr-watch [instructions|watch|status|stop]",
		handler: async (args, ctx) => {
			if (!monitor) return
			try {
				ctx.ui.notify(formatPRWatchStatus(await runPRWatchCommand(monitor, args)), "info")
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
			}
		},
	})
	pi.on("agent_settled", async (event) => {
		await monitor?.settled(event.aborted)
	})
	pi.on("session_shutdown", async (_event, ctx) => {
		monitors.delete(ctx.sessionManager)
		await monitor?.dispose()
		monitor = undefined
	})
}
