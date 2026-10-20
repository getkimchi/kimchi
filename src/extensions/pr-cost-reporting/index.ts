import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { IS_ACP_MODE } from "../../modes/acp/state.js"
import {
	claimDefaultNotice,
	prReportingHeaderValue,
	prReportingSkipReason,
	readPRReportingConsent,
	savePRReportingChoice,
	setPRReportingSessionMode,
} from "./consent.js"
import { statusText } from "./status.js"

const NOTICE = "PR costs are reported to your account by the Kimchi gateway. Turn off with /pr-reporting off."

const ARGUMENT_COMPLETIONS = [
	{ value: "on", label: "on", description: "Let the Kimchi gateway report PR costs to your account" },
	{ value: "off", label: "off", description: "Ask the Kimchi gateway not to report PR costs" },
	{ value: "status", label: "status", description: "Show the setting and whether this session is reported" },
]

/** The `/pr-reporting` choice that tells the Kimchi gateway whether it may report PR costs, and its one-time notice. */
export default function prCostReportingExtension(pi: ExtensionAPI): void {
	// A custom entry preserves other startup notices and stays out of model context.
	pi.registerEntryRenderer<string>("pr-cost-reporting-notice", (entry, _options, theme) =>
		typeof entry.data === "string" ? new Text(theme.fg("dim", entry.data), 1, 0) : undefined,
	)

	let pending = Promise.resolve()

	/** A session the gateway reports by default says so once per installation. */
	async function showNotice(ctx: ExtensionContext): Promise<void> {
		try {
			if (!ctx.hasUI || prReportingHeaderValue() !== "proxy" || readPRReportingConsent().source !== "default") return
			if (!(await claimDefaultNotice())) return
			// Studio shows notifications but not custom entries.
			if (IS_ACP_MODE) ctx.ui.notify(NOTICE, "info")
			else pi.appendEntry("pr-cost-reporting-notice", NOTICE)
		} catch {
			// The notice is informational; an unreadable state already reports nothing.
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		setPRReportingSessionMode(ctx.mode)
		// Studio drops notifications for a session it has not registered yet, so it gets the notice after a turn.
		if (!IS_ACP_MODE) await showNotice(ctx)
	})

	pi.on("agent_end", (_event, ctx) => {
		// Disk reads must not hold turn completion or the dialogs waiting for idle.
		if (IS_ACP_MODE) pending = pending.then(() => showNotice(ctx))
	})

	pi.on("session_shutdown", async () => {
		await pending
	})

	pi.registerCommand("pr-reporting", {
		description: "PR cost reporting by the Kimchi gateway: on, off, or status (defaults to the SaaS telemetry setting)",
		getArgumentCompletions: (prefix) =>
			ARGUMENT_COMPLETIONS.filter((item) => item.value.startsWith(prefix.trimStart().toLowerCase())),
		handler: async (args, ctx) => {
			const command = args.trim() || "status"
			if (!["on", "off", "status"].includes(command)) {
				ctx.ui.notify("Usage: /pr-reporting on|off|status", "info")
				return
			}
			try {
				if (command === "status") {
					ctx.ui.notify(statusText(readPRReportingConsent(), prReportingSkipReason()), "info")
					return
				}
				await savePRReportingChoice(command === "on")
				const skipReason = prReportingSkipReason()
				ctx.ui.notify(
					command === "on"
						? `PR reporting on. The Kimchi gateway reports PR costs to your account from the requests it serves; Kimchi adds their session and turn IDs.${skipReason ? `\nThis session is not reported: ${skipReason}.` : ""}`
						: "PR reporting off. Kimchi asks the gateway not to report PR costs for its requests. Reports already accepted remain on the server.",
					"info",
				)
			} catch {
				ctx.ui.notify("PR reporting state could not be saved or read.", "warning")
			}
		},
	})
}
