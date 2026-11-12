import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../../cli-args.js"
import { formatPRWatchStatus, runPRWatchCommand } from "./command.js"
import { PRMonitor } from "./monitor.js"
import { PRMonitorPanel } from "./panel.js"
import type { PRMonitorState } from "./types.js"
import { renderPRWatchWidget } from "./widget.js"

const monitors = new WeakMap<object, PRMonitor>()

export function getPRMonitor(sessionManager: object): PRMonitor | undefined {
	return monitors.get(sessionManager)
}

export default function prMonitorExtension(pi: ExtensionAPI): void {
	let monitor: PRMonitor | undefined
	let panel: PRMonitorPanel | undefined
	pi.registerFlag("pr-watch", {
		type: "boolean",
		default: false,
		description: "Watch this session's PR without granting automatic fixes.",
	})
	pi.on("session_start", async (_event, ctx) => {
		panel?.close()
		panel = undefined
		await monitor?.dispose()
		monitor = new PRMonitor(pi, ctx)
		if (ctx.mode === "tui") {
			const updateUI = (state: PRMonitorState) => {
				ctx.ui.setStatus("pr-watch", state.enabled ? `PR watch: ${state.phase}` : undefined)
				ctx.ui.setWidget(
					"pr-watch",
					state.enabled
						? (_tui, theme) => ({ render: (width) => renderPRWatchWidget(state, width, theme), invalidate() {} })
						: undefined,
					{ placement: "aboveEditor" },
				)
			}
			monitor.setNotify(updateUI)
			updateUI(monitor.snapshot)
		}
		monitors.set(ctx.sessionManager, monitor)
		const prior = ctx.sessionManager
			.getEntries()
			.some((entry) => entry.type === "custom" && entry.customType === "pr_monitor")
		if (getParsedCliArgs().options["pr-watch"] === true && !prior) await monitor.configure(true, false)
	})
	async function openPanel(ctx: ExtensionContext): Promise<void> {
		if (!monitor) return
		panel?.close()
		const current = monitor
		let opened: PRMonitorPanel | undefined
		try {
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				opened = new PRMonitorPanel(current, tui, () => done(), theme)
				panel = opened
				return opened
			})
		} finally {
			opened?.dispose()
			if (panel === opened) panel = undefined
		}
	}
	pi.registerCommand("pr-watch", {
		description:
			"Watch this PR locally and fix CI or review feedback: /pr-watch [instructions|watch|monitor|status|stop]",
		handler: async (args, ctx) => {
			if (!monitor) return
			try {
				if (args.trim() === "monitor" && ctx.mode === "tui") return await openPanel(ctx)
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
		panel?.close()
		panel = undefined
		monitors.delete(ctx.sessionManager)
		await monitor?.dispose()
		monitor = undefined
		if (ctx.mode === "tui") {
			ctx.ui.setStatus("pr-watch", undefined)
			ctx.ui.setWidget("pr-watch", undefined)
		}
	})
}
