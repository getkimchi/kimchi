import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { readOutboxStatus } from "@getkimchi/kimchi-bridge/ledger"
import {
	dueLimitNotices,
	type ReportingState,
	readReportingState,
	setReportingEnabled,
	takeLimitNotices,
	takeReportingNotice,
} from "@getkimchi/kimchi-bridge/reconcile"
import { readPrReportingConsent, writePrReportingConsent } from "../../config.js"
import { IS_ACP_MODE } from "../../modes/acp/state.js"
import { isTelemetryEnabled } from "../../telemetry-policy.js"
import {
	requestWorkReconciliation,
	subscribeReportingReconciliation,
} from "../work-attribution/reconcile-supervisor.js"
import { WORK_CHANGED_EVENT, WORK_STATE_REQUEST_EVENT, type WorkStateRequest } from "../work-attribution.js"
import { uploadSkipReason } from "./automation.js"
import { limitNoticeTexts, statusText } from "./status.js"

const ARGUMENT_COMPLETIONS = [
	{ value: "on", label: "on", description: "Report PR costs to your account" },
	{ value: "off", label: "off", description: "Pause reporting and retain pending uploads" },
	{ value: "status", label: "status", description: "Show the setting, queued reports and problems" },
]

/**
 * Seed the config-owned consent from the legacy state.json mirror. Concurrent sessions race
 * the seed from the same source file and write equivalent values, so the last write wins
 * safely; an explicit choice written while the legacy state was being read is re-checked
 * for and never overwritten.
 */
async function migrateReportingConsent(): Promise<void> {
	if (readPrReportingConsent() !== undefined) return
	let state: ReportingState
	try {
		state = await readReportingState(getAgentDir())
	} catch (error) {
		// Migration must never block startup: log and leave the key absent, so /pr-reporting
		// status keeps showing the legacy value until the user chooses.
		console.error("kimchi: could not migrate PR reporting consent:", error instanceof Error ? error.message : error)
		return
	}
	if (readPrReportingConsent() !== undefined) return
	// followsTelemetry wins over the derived enabled bit: a default queue reads
	// {enabled:false, followsTelemetry:true} while telemetry is off, and that inherited
	// policy must not become an explicit opt-out that telemetry cannot revive.
	writePrReportingConsent(state.followsTelemetry ? "follow-telemetry" : state.enabled === false ? "off" : "on")
}

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
	/** Runs once per process; the config key it seeds is the migration's completion mark. */
	let consentMigration: Promise<void> | undefined

	async function reportingEnabled(): Promise<boolean> {
		try {
			const state = await readReportingState(getAgentDir())
			const ctx = context
			if (ctx?.hasUI && state.enabled && state.followsTelemetry && !state.defaultNoticeShown)
				if (await takeReportingNotice(getAgentDir())) {
					const text =
						"PR costs are reported to your account (repository/PR details and request/billing IDs). Turn off with /pr-reporting off."
					// Studio shows notifications but not custom entries.
					if (IS_ACP_MODE) ctx.ui.notify(text, "info")
					else pi.appendEntry("pr-cost-reporting-notice", text)
				}
			const due = dueLimitNotices(state)
			if (ctx?.hasUI && (due.repositories.length || due.pauses.length))
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
		// Sessions that never upload (CI, print or JSON mode, benchmarks) skip the pass; the next interactive
		// session builds the same reports from the same journals.
		if (request.tracking && request.current && !skipReason) {
			stop ??= subscribeReportingReconciliation(() => context?.cwd)
		} else if (stop) {
			draining = Promise.all([draining, stop()]).then(() => {})
			stop = undefined
		}
	}
	pi.events.on(WORK_CHANGED_EVENT, () => synchronize())

	pi.on("session_start", async (_event, ctx) => {
		consentMigration ??= migrateReportingConsent()
		await consentMigration
		started = true
		skipReason = uploadSkipReason(ctx.mode)
		synchronize(ctx)
		// Studio drops notifications for a session it has not registered yet, so it gets the notice after a turn.
		if (stop && !IS_ACP_MODE) await reportingEnabled()
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
		getArgumentCompletions: (prefix) =>
			ARGUMENT_COMPLETIONS.filter((item) => item.value.startsWith(prefix.trimStart().toLowerCase())),
		handler: async (args, ctx) => {
			const command = args.trim() || "status"
			if (!["on", "off", "status"].includes(command)) {
				ctx.ui.notify("Usage: /pr-reporting on|off|status", "info")
				return
			}
			try {
				if (command === "on") {
					// The config-owned choice is written first: even when the legacy state write
					// fails, the explicit opt-in is durable and reporting cannot come back on.
					writePrReportingConsent("on")
					await setReportingEnabled(getAgentDir(), true)
					if (started && stop) requestWorkReconciliation()
					ctx.ui.notify(
						"PR reporting on. Kimchi will send observed usage, work and repository/PR metadata, request and billing IDs, timestamps, and matching evidence to your account. Prompts, plan contents, local paths, and file contents stay local. Delivery runs in the background.",
						"info",
					)
				} else if (command === "off") {
					// Same ordering as "on": the opt-out must survive a failed legacy write.
					writePrReportingConsent("off")
					await setReportingEnabled(getAgentDir(), false)
					ctx.ui.notify(
						"PR reporting off. Pending uploads are paused and retained locally. Previously accepted reports remain on the server.",
						"info",
					)
				} else {
					const consent = readPrReportingConsent()
					const status = statusText(
						await readReportingState(getAgentDir()),
						uploadSkipReason(ctx.mode),
						Date.now(),
						readOutboxStatus(getAgentDir()),
						// The config key wins once it exists; before that the legacy state.json
						// value is the only recorded choice.
						consent && { value: consent, telemetryEnabled: isTelemetryEnabled() },
					)
					ctx.ui.notify(status.text, status.warning ? "warning" : "info")
				}
			} catch {
				ctx.ui.notify("PR reporting state could not be saved or read. Existing reports were retained.", "warning")
			}
		},
	})
}
