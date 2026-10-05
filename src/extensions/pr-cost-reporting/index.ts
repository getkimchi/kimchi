import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent"
import { subscribeReportingReconciliation } from "../work-attribution/reconcile-supervisor.js"
import { WORK_CHANGED_EVENT, WORK_STATE_REQUEST_EVENT, type WorkStateRequest } from "../work-attribution.js"
import { readReportingState, setReportingEnabled } from "./queue.js"
import { reconcileReporting } from "./worker.js"

export default function prCostReportingExtension(pi: ExtensionAPI): void {
	let context: ExtensionContext | undefined
	let started = false
	let activeKey = ""
	let stop: (() => Promise<void>) | undefined
	let draining = Promise.resolve()
	function synchronize(ctx = context): void {
		if (!started || !ctx) return
		const request: WorkStateRequest = {}
		pi.events.emit(WORK_STATE_REQUEST_EVENT, request)
		const next = request.current?.ctx ?? ctx
		const key = JSON.stringify([next.cwd, next.sessionManager.getSessionId()])
		if (activeKey && activeKey !== key && stop) {
			draining = Promise.all([draining, stop()]).then(() => {})
			stop = undefined
		}
		context = next
		activeKey = key
		if (request.tracking && request.current) {
			stop ??= subscribeReportingReconciliation(async (agentDir, signal, assertLease) => {
				if (context) await reconcileReporting(agentDir, context.cwd, signal, assertLease)
			})
		} else if (stop) {
			draining = Promise.all([draining, stop()]).then(() => {})
			stop = undefined
		}
	}
	pi.events.on(WORK_CHANGED_EVENT, () => synchronize())
	pi.on("session_start", (_event, ctx) => {
		started = true
		synchronize(ctx)
	})
	pi.on("session_shutdown", async () => {
		started = false
		await Promise.all([draining, stop?.()])
		stop = undefined
		context = undefined
	})
	pi.registerCommand("pr-reporting", {
		description: "Opt in to PR cost reporting: on, off, or status (default off)",
		handler: async (args, ctx) => {
			const command = args.trim() || "status"
			if (!["on", "off", "status"].includes(command)) {
				ctx.ui.notify("Usage: /pr-reporting on|off|status", "info")
				return
			}
			try {
				if (command === "on") {
					await setReportingEnabled(getAgentDir(), true)
					ctx.ui.notify(
						"PR reporting on. Kimchi will send repository/PR metadata, request and billing IDs, timestamps, and matching evidence to your account. Prompts, plans, local work/session IDs, paths, and prices stay local. Delivery runs in the background.",
						"info",
					)
				} else if (command === "off") {
					await setReportingEnabled(getAgentDir(), false)
					ctx.ui.notify(
						"PR reporting off. Pending uploads were deleted; local work history and revision counters were retained. Previously accepted reports remain on the server.",
						"info",
					)
				} else {
					const state = await readReportingState(getAgentDir())
					const entries = Object.values(state.entries)
					const pending = entries.filter((entry) => entry.pending)
					const errors = [...new Set([state.error, ...pending.map((entry) => entry.lastError)].filter(Boolean))]
					ctx.ui.notify(
						[
							`PR reporting: ${state.enabled ? "on" : "off"}`,
							`Queued repositories: ${pending.length}`,
							`Acknowledged repositories: ${entries.filter((entry) => entry.lastAcknowledgedAt).length}`,
							...errors,
						].join("\n"),
						errors.length ? "warning" : "info",
					)
				}
			} catch {
				ctx.ui.notify("PR reporting state could not be saved or read. Existing reports were retained.", "warning")
			}
		},
	})
}
