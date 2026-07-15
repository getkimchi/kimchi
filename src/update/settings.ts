// Persistence for the harness auto-update toggle.
//
// Auto-update state lives in its OWN file (auto-update.json), separate
// from the shared settings.json. This avoids two problems with the
// previous approach (which read-modify-wrote settings.json):
//
//   1. Lossy overwrite: if readRaw() saw malformed JSON it returned {},
//      so the next save would overwrite every unrelated setting with
//      only { autoUpdate }.
//   2. Concurrent-process race: two kimchi processes writing settings.json
//      via the same `settings.json.tmp` plus read-modify-write could lose
//      each other's keys.
//
// Using a dedicated file with a process-unique tmp name eliminates both:
// there are no unrelated keys to clobber, and the tmp name includes the
// PID so concurrent processes don't collide on the rename.

import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { readJson, writeJson } from "../config/json.js"

/** Path to the dedicated auto-update state file. Separate from the shared
 *  settings.json so read-modify-writes here can never clobber unrelated keys. */
function autoUpdateStatePath(): string {
	return join(getAgentDir(), "auto-update.json")
}

interface AutoUpdateState {
	/** Opt-in (default false) for the initial rollout. */
	autoUpdate?: boolean
	/** One-time onboarding toast shown flag. */
	autoUpdateNoticeShown?: boolean
}

function readState(path: string): AutoUpdateState {
	try {
		return readJson(path) as AutoUpdateState
	} catch (err) {
		// readJson throws on malformed JSON (by design — corrupt configs should
		// be visible). Auto-update is non-critical, so swallow and return the
		// default state rather than crashing the session.
		const reason = err instanceof Error ? err.message : String(err)
		console.warn(`[kimchi-update] Ignoring malformed auto-update state at ${path}: ${reason}`)
		return {}
	}
}

/** Default for autoUpdate is `false` (opt-in) for the initial rollout.
 *  Plan: ship opt-in first, monitor for regressions, then flip to `true`
 *  (opt-out) to match Claude Code's native-install default. */
export function loadAutoUpdateSetting(): boolean {
	const state = readState(autoUpdateStatePath())
	// Missing or wrong type → opt-in default. Only an explicit `true` opts in.
	if (typeof state.autoUpdate !== "boolean") return false
	return state.autoUpdate
}

/** Default for the one-time onboarding toast is `false` — we haven't shown it yet. */
export function loadAutoUpdateNoticeShown(): boolean {
	const state = readState(autoUpdateStatePath())
	return state.autoUpdateNoticeShown === true
}

export function saveAutoUpdateSetting(enabled: boolean): void {
	const path = autoUpdateStatePath()
	const next = { ...readState(path), autoUpdate: enabled }
	writeJson(path, next)
}

export function markAutoUpdateNoticeShown(): void {
	const path = autoUpdateStatePath()
	const next = { ...readState(path), autoUpdateNoticeShown: true }
	writeJson(path, next)
}
