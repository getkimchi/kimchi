import { note } from "@clack/prompts"
import { writeTelemetryEnabled } from "../../config.js"
import type { Outcome } from "../prompt.js"
import { select } from "../prompt.js"
import type { WizardState } from "../state.js"

/**
 * Standalone telemetry prompt. Can be used both inside the setup wizard
 * and by standalone commands that need to ask for telemetry preference.
 *
 * Returns the raw outcome so callers decide what to do with back/cancel.
 * Persists the choice to config.json on success.
 */
export async function promptTelemetry(opts: { backable: boolean }): Promise<Outcome<boolean>> {
	note(
		[
			"Help us improve your experience by sharing anonymous usage metrics.",
			"This data enhances your Coding Report in the Kimchi console.",
			"",
			"What we collect:",
			"  • Number of requests and sessions",
			"  • Token usage and model selection",
			"  • Error rates and performance metrics",
			"",
			"What we don't collect:",
			"  • Your actual prompts or code",
			"  • File contents or sensitive data",
			"  • Personal information",
		].join("\n"),
		"Usage telemetry",
	)

	const r = await select<"on" | "off">({
		message: "Share anonymous usage data?",
		options: [
			{ value: "on", label: "Yes, share anonymous usage data" },
			{ value: "off", label: "No, keep my usage private" },
		],
		initialValue: "on",
		backable: opts.backable,
	})
	if (r.kind === "back") return { kind: "back" }
	if (r.kind === "cancel") return { kind: "cancel" }

	const enabled = r.value === "on"
	writeTelemetryEnabled(enabled)
	return { kind: "next", value: enabled }
}

/**
 * Telemetry step — explain exactly what we collect and offer opt-in /
 * opt-out. The disclosure copy is load-bearing — be careful when editing.
 *
 * The choice is persisted to ~/.config/kimchi/config.json's
 * telemetry.enabled. $KIMCHI_TELEMETRY_ENABLED still wins over the
 * persisted value (set by readTelemetryConfig on launch), so users who
 * change their mind via env var don't need to re-run setup.
 */
export async function runTelemetryStep(state: WizardState, opts: { backable: boolean }): Promise<void> {
	const r = await promptTelemetry(opts)
	if (r.kind === "back") {
		state.back = true
		return
	}
	if (r.kind === "cancel") {
		state.cancelled = true
		return
	}
	state.telemetryEnabled = r.value
}
