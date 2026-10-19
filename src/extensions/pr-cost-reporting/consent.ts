import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent"
import { lock } from "proper-lockfile"
import { invalidateJsonCache, readJson, readJsonCached, writeFileDurably } from "../../config/json.js"
import { isResourceEnabled } from "../../resources/store.js"
import { debugPRCost } from "../../shared/pr-cost-log.js"
import { isTelemetryEnabled } from "../../telemetry-policy.js"
import { reportingSkipReason } from "./automation.js"
import { COST_PER_PR_RESOURCE_ID } from "./resource.js"

/** Tells the Kimchi gateway whether it may report this request's PR costs: `proxy` when it may, otherwise `off`. */
export const PR_REPORTING_HEADER = "X-Kimchi-PR-Reporting"

export interface PRReportingConsent {
	enabled: boolean
	/** `default` follows the SaaS telemetry setting; `choice` is a saved `/pr-reporting on|off`. */
	source: "default" | "choice"
}

/** Writes keep any other fields an older Kimchi saved in the same file. */
interface SavedState {
	version?: 1
	enabled?: boolean
	/** Set while the SaaS telemetry setting decides. */
	followsTelemetry?: true
	defaultNoticeShown?: true
}

/** The main session's mode: print and JSON runs never report. Subagents share the process and its decision. */
let sessionMode: ExtensionContext["mode"] | undefined

export function setPRReportingSessionMode(mode: ExtensionContext["mode"] | undefined): void {
	sessionMode = mode
}

export function prReportingStatePath(agentDir = getAgentDir()): string {
	return join(agentDir, "pr-cost-reporting", "state.json")
}

const isEmpty = (state: object) => Object.keys(state).length === 0
const isUnsetOrTrue = (value: unknown) => value === undefined || value === true

/** No file yet is a valid state; anything else must look like a saved choice. */
function validState(state: Record<string, unknown>, path: string): SavedState {
	const isSavedChoice =
		state.version === 1 &&
		typeof state.enabled === "boolean" &&
		isUnsetOrTrue(state.followsTelemetry) &&
		isUnsetOrTrue(state.defaultNoticeShown)
	if (!isEmpty(state) && !isSavedChoice) throw new Error(`Invalid PR reporting state in ${path}`)
	return state
}

const followsDefault = (state: SavedState) => isEmpty(state) || state.followsTelemetry === true
const noticeDue = (state: SavedState) => followsDefault(state) && !state.defaultNoticeShown

/** The saved `/pr-reporting on|off`, or else the SaaS telemetry setting under the org policy; throws if unreadable. */
export function readPRReportingConsent(agentDir = getAgentDir()): PRReportingConsent {
	const path = prReportingStatePath(agentDir)
	const state = validState(readJsonCached(path), path)
	return followsDefault(state)
		? { enabled: isTelemetryEnabled(), source: "default" }
		: { enabled: state.enabled === true, source: "choice" }
}

/** Why this process never reports PR costs, or undefined when it may. */
export function prReportingSkipReason(): string | undefined {
	return reportingSkipReason(sessionMode)
}

/** `proxy` while Cost per PR is on, this process may report and consent is on; `off` otherwise, also when unreadable. */
export function prReportingHeaderValue(agentDir = getAgentDir()): "proxy" | "off" {
	try {
		return isResourceEnabled(COST_PER_PR_RESOURCE_ID) &&
			!prReportingSkipReason() &&
			readPRReportingConsent(agentDir).enabled
			? "proxy"
			: "off"
	} catch (error) {
		debugPRCost("PR reporting state unavailable:", error)
		return "off"
	}
}

/** Replace the saved state under its lock and say whether it was written; `mutate` returns false to leave it as it is. */
async function updateState(agentDir: string, mutate: (state: SavedState) => boolean): Promise<boolean> {
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
		const state = validState(readJson(path), path)
		if (!mutate(state)) return false
		await writeFileDurably(path, `${JSON.stringify(state)}\n`, () => {
			if (compromised) throw compromised
		})
		invalidateJsonCache(path)
		return true
	} finally {
		if (!compromised) await release()
	}
}

/** Save an explicit `/pr-reporting on|off`; it outlives restarts and changes in the SaaS telemetry setting. */
export async function savePRReportingChoice(enabled: boolean, agentDir = getAgentDir()): Promise<void> {
	await updateState(agentDir, (state) => {
		state.version = 1
		state.enabled = enabled
		// JSON leaves the field out.
		state.followsTelemetry = undefined
		return true
	})
}

/** Claim the one-time notice that PR costs are reported by default, so concurrent sessions show it once. */
export async function claimDefaultNotice(agentDir = getAgentDir()): Promise<boolean> {
	const path = prReportingStatePath(agentDir)
	if (!noticeDue(validState(readJsonCached(path), path))) return false
	return updateState(agentDir, (state) => {
		if (!noticeDue(state)) return false
		state.version = 1
		state.enabled = isTelemetryEnabled()
		state.followsTelemetry = true
		state.defaultNoticeShown = true
		return true
	})
}
