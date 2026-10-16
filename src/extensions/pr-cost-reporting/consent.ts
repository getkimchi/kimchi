import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent"
import { lock } from "proper-lockfile"
import { invalidateJsonCache, readJson, readJsonCached, writeFileDurably } from "../../config/json.js"
import { isResourceEnabled } from "../../resources/store.js"
import { isTelemetryEnabled } from "../../telemetry-policy.js"
import { COST_PER_PR_RESOURCE_ID } from "../work-attribution/resource.js"
import { reportingSkipReason } from "./automation.js"

/** Tells the Kimchi gateway whether it may report this request's PR costs: `proxy` when it may, otherwise `off`. */
export const PR_REPORTING_HEADER = "X-Kimchi-PR-Reporting"

export type PRReportingHeaderValue = "proxy" | "off"

export interface PRReportingConsent {
	enabled: boolean
	/** `default` follows the SaaS telemetry setting; `choice` is a saved `/pr-reporting on|off`. */
	source: "default" | "choice"
}

/**
 * The saved state: `enabled` (with `followsTelemetry` while the SaaS setting decides) and whether the one-time notice
 * was shown. Writes keep any other fields an older Kimchi saved in the same file.
 */
type SavedState = Record<string, unknown>

/** The main session's mode: print and JSON runs never report. Subagents share the process and its decision. */
let sessionMode: ExtensionContext["mode"] | undefined

export function setPRReportingSessionMode(mode: ExtensionContext["mode"] | undefined): void {
	sessionMode = mode
}

export function prReportingStatePath(agentDir = getAgentDir()): string {
	return join(agentDir, "pr-cost-reporting", "state.json")
}

/** No file yet is a valid state; anything else must look like a saved choice. */
function validState(state: SavedState): SavedState {
	if (
		Object.keys(state).length &&
		(state.version !== 1 ||
			typeof state.enabled !== "boolean" ||
			(state.followsTelemetry !== undefined && state.followsTelemetry !== true) ||
			(state.defaultNoticeShown !== undefined && state.defaultNoticeShown !== true))
	)
		throw new Error("Invalid PR reporting state")
	return state
}

const followsDefault = (state: SavedState) => !Object.keys(state).length || state.followsTelemetry === true

/**
 * The saved choice and its source. Reporting follows the SaaS telemetry setting, with the org's usage-reporting
 * policy applied, until an explicit `/pr-reporting on|off` is saved. Throws when the saved state is unreadable.
 */
export function readPRReportingConsent(agentDir = getAgentDir()): PRReportingConsent {
	const state = validState(readJsonCached(prReportingStatePath(agentDir)))
	return followsDefault(state)
		? { enabled: isTelemetryEnabled(), source: "default" }
		: { enabled: state.enabled === true, source: "choice" }
}

/** Why this process never reports PR costs, or undefined when it may. */
export function prReportingSkipReason(env = process.env): string | undefined {
	return reportingSkipReason(sessionMode, env)
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

/** Replace the saved state under its lock; `mutate` returns false to leave the file as it is. */
async function updateState(agentDir: string, mutate: (state: SavedState) => boolean): Promise<void> {
	const path = prReportingStatePath(agentDir)
	const directory = dirname(path)
	await mkdir(directory, { recursive: true, mode: 0o700 })
	let compromised: Error | undefined
	const release = await lock(directory, {
		retries: { retries: 20, minTimeout: 10, maxTimeout: 50 },
		stale: 5000,
		update: 1000,
		onCompromised: (error) => {
			compromised = error
		},
	})
	try {
		const state = validState(readJson(path))
		if (!mutate(state)) return
		await writeFileDurably(path, `${JSON.stringify(state)}\n`, () => {
			if (compromised) throw compromised
		})
		invalidateJsonCache(path)
	} finally {
		if (!compromised) await release()
	}
}

/** Save an explicit `/pr-reporting on|off`; it outlives restarts and changes in the SaaS telemetry setting. */
export function savePRReportingChoice(enabled: boolean, agentDir = getAgentDir()): Promise<void> {
	return updateState(agentDir, (state) => {
		state.version = 1
		state.enabled = enabled
		// JSON leaves the field out.
		state.followsTelemetry = undefined
		return true
	})
}

/** Claim the one-time notice that PR costs are reported by default, so concurrent sessions show it once. */
export async function takeReportingNotice(agentDir = getAgentDir()): Promise<boolean> {
	const saved = validState(readJsonCached(prReportingStatePath(agentDir)))
	if (!followsDefault(saved) || saved.defaultNoticeShown) return false
	let claimed = false
	await updateState(agentDir, (state) => {
		if (!followsDefault(state) || state.defaultNoticeShown) return false
		Object.assign(state, {
			version: 1,
			enabled: isTelemetryEnabled(),
			followsTelemetry: true,
			defaultNoticeShown: true,
		})
		claimed = true
		return true
	})
	return claimed
}
