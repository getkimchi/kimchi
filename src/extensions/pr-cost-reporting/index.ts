import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { IS_ACP_MODE } from "../../modes/acp/state.js"
import {
	requestWorkReconciliation,
	subscribeReportingReconciliation,
} from "../work-attribution/reconcile-supervisor.js"
import { WORK_CHANGED_EVENT, WORK_STATE_REQUEST_EVENT, type WorkStateRequest } from "../work-attribution.js"
import { uploadSkipReason } from "./automation.js"
import {
	dueLimitNotices,
	readReportingState,
	setReportingEnabled,
	takeLimitNotices,
	takeReportingNotice,
} from "./queue.js"
import { limitNoticeTexts, statusText } from "./status.js"
import { reconcileReporting } from "./worker.js"

export default function prCostReportingExtension(pi: ExtensionAPI): void {
	// A custom entry preserves other startup notices and stays out of model context.
	pi.registerEntryRenderer<string>("pr-cost-reporting-notice", (entry, _options, theme) =>
		typeof entry.data === "string" ? new Text(theme.fg("dim", entry.data), 1, 0) : undefined,
	)
	let context: ExtensionContext | undefined
	/** CI, print, JSON and benchmark runs keep local attribution but never upload. */
	let skipReason: string | undefined
	let started = false
	let activeKey = ""
	let stop: (() => Promise<void>) | undefined
	let draining = Promise.resolve()
	async function reportingEnabled(showNotice = true): Promise<boolean> {
		try {
			const state = await readReportingState(getAgentDir())
			const ctx = context
			if (showNotice && ctx?.hasUI && state.enabled && state.followsTelemetry && !state.defaultNoticeShown)
				if (await takeReportingNotice(getAgentDir())) {
					const text =
						"PR costs are reported to your account (repository/PR details and request/billing IDs). Turn off with /pr-reporting off."
					// Studio shows notifications but not custom entries.
					if (IS_ACP_MODE) ctx.ui.notify(text, "info")
					else pi.appendEntry("pr-cost-reporting-notice", text)
				}
			const due = dueLimitNotices(state)
			if (showNotice && ctx?.hasUI && (due.repositories.length || due.pauses.length))
				for (const text of limitNoticeTexts(await takeLimitNotices(getAgentDir()))) ctx.ui.notify(text, "warning")
			return state.enabled
		} catch {
			return false
		}
	}
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
				if (context) await reconcileReporting(agentDir, context.cwd, signal, assertLease, !skipReason)
			})
		} else if (stop) {
			draining = Promise.all([draining, stop()]).then(() => {})
			stop = undefined
		}
	}
	pi.events.on(WORK_CHANGED_EVENT, () => synchronize())
	pi.on("session_start", async (_event, ctx) => {
		started = true
		skipReason = uploadSkipReason(ctx.mode)
		synchronize(ctx)
		// Studio drops notifications for a session it has not registered yet, so it gets the notice after a turn.
		if (stop) await reportingEnabled(!IS_ACP_MODE)
	})
	pi.on("agent_end", () => {
		// Disk reads must not hold turn completion or the dialogs waiting for idle.
		draining = draining.then(async () => {
			if (started && stop && (await reportingEnabled())) requestWorkReconciliation()
		})
	})
	pi.on("session_shutdown", async () => {
		started = false
		await Promise.all([draining, stop?.()])
		stop = undefined
		context = undefined
	})
	pi.registerCommand("pr-reporting", {
		description: "PR cost reporting: on, off, or status (defaults to the SaaS telemetry setting)",
		handler: async (args, ctx) => {
			const command = args.trim() || "status"
			if (!["on", "off", "status"].includes(command)) {
				ctx.ui.notify("Usage: /pr-reporting on|off|status", "info")
				return
			}
			try {
				if (command === "on") {
					await setReportingEnabled(getAgentDir(), true)
					if (started && stop) requestWorkReconciliation()
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
					const status = statusText(await readReportingState(getAgentDir()), uploadSkipReason(ctx.mode))
					ctx.ui.notify(status.text, status.warning ? "warning" : "info")
				}
			} catch {
				ctx.ui.notify("PR reporting state could not be saved or read. Existing reports were retained.", "warning")
			}
		},
	})
}
