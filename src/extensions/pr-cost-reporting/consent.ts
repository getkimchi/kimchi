import { join } from "node:path"
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent"
import { readJsonCached } from "../../config/json.js"
import { isResourceEnabled } from "../../resources/store.js"
import { isTelemetryEnabled } from "../../telemetry-policy.js"
import { COST_PER_PR_RESOURCE_ID } from "../work-attribution/resource.js"
import { uploadSkipReason } from "./automation.js"

/** Tells the Kimchi gateway whether it may report this request's PR costs: `proxy` when it may, otherwise `off`. */
export const PR_REPORTING_HEADER = "X-Kimchi-PR-Reporting"

export type PRReportingHeaderValue = "proxy" | "off"

export interface PRReportingConsent {
	enabled: boolean
	/** `default` follows the SaaS telemetry setting; `choice` is a saved `/pr-reporting on|off`. */
	source: "default" | "choice"
}

/** The main session's mode: print and JSON runs never report. Subagents share the process and its decision. */
let sessionMode: ExtensionContext["mode"] | undefined

export function setPRReportingSessionMode(mode: ExtensionContext["mode"] | undefined): void {
	sessionMode = mode
}

export function prReportingStatePath(agentDir = getAgentDir()): string {
	return join(agentDir, "pr-cost-reporting", "state.json")
}

/**
 * The saved choice and its source. Reporting follows the SaaS telemetry setting, with the org's usage-reporting
 * policy applied, until an explicit `/pr-reporting on|off` is saved. Throws when the saved state is unreadable.
 */
export function readPRReportingConsent(agentDir = getAgentDir()): PRReportingConsent {
	const state = readJsonCached(prReportingStatePath(agentDir))
	if (!Object.keys(state).length) return { enabled: isTelemetryEnabled(), source: "default" }
	if (
		state.version !== 1 ||
		typeof state.enabled !== "boolean" ||
		(state.followsTelemetry !== undefined && state.followsTelemetry !== true)
	)
		throw new Error("Invalid PR reporting state")
	return state.followsTelemetry
		? { enabled: isTelemetryEnabled(), source: "default" }
		: { enabled: state.enabled, source: "choice" }
}

/** Why this process never reports PR costs, or undefined when it may. */
export function prReportingSkipReason(env = process.env): string | undefined {
	return uploadSkipReason(sessionMode, env)
}

/**
 * The value of {@link PR_REPORTING_HEADER} for requests sent now: `proxy` only while Cost per PR is enabled, this
 * process may report, and consent is on. An unreadable saved state counts as `off`.
 */
export function prReportingHeaderValue(agentDir = getAgentDir()): PRReportingHeaderValue {
	try {
		return isResourceEnabled(COST_PER_PR_RESOURCE_ID) &&
			!prReportingSkipReason() &&
			readPRReportingConsent(agentDir).enabled
			? "proxy"
			: "off"
	} catch {
		return "off"
	}
}
