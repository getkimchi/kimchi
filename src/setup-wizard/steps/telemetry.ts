import { note } from "@clack/prompts"
import { writeTelemetryEnabled } from "../../config.js"
import { isTelemetryPolicyEnforced, usageReportingPolicy } from "../../telemetry-policy.js"
import type { Outcome } from "../prompt.js"
import type { WizardState } from "../state.js"

/**
 * Standalone telemetry notice. Can be used both inside the setup wizard
 * and by standalone commands that need to inform users about telemetry.
 *
 * Automatically enables telemetry and persists the choice to config.json.
 * When an org usage-reporting policy is enforced, the choice is not the
 * user's to make: show the managed state and return it without persisting
 * anything — the user's stored preference (if any) applies again once the
 * policy relaxes to USER_CHOICE.
 */
export async function promptTelemetry(_opts: { backable: boolean }): Promise<Outcome<boolean>> {
	if (isTelemetryPolicyEnforced()) {
		const enforced = usageReportingPolicy() === "FORCE_ON"
		note(
			`Usage telemetry is managed by your organization (enforced ${enforced ? "on" : "off"}). Any config preference you have stays untouched and applies again if the policy relaxes.`,
			"Usage telemetry",
		)
		return { kind: "next", value: enforced }
	}

	note(
		"Kimchi collects usage data (commands run, models used, error rates) to improve the product. This data is associated with your account. No prompt content or code is collected.",
		"Usage telemetry",
	)

	writeTelemetryEnabled(true)
	return { kind: "next", value: true }
}

/**
 * Telemetry step — inform the user that telemetry is enabled by default.
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
