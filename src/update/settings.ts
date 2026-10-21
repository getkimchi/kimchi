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
import { readJsonCached, writeJson } from "../config/json.js"

/** Path to the dedicated auto-update state file. Separate from the shared
 *  settings.json so read-modify-writes here can never clobber unrelated keys. */
function autoUpdateStatePath(): string {
	return join(getAgentDir(), "auto-update.json")
}

interface AutoUpdateState {
	/** Opt-out (default true). Only an explicit `false` disables. */
	autoUpdate?: boolean
	/** One-time onboarding toast shown flag. The launch auto-update waits
	 *  for it, so nobody is updated before being told. */
	autoUpdateNoticeShown?: boolean
}

function readState(path: string): AutoUpdateState {
	try {
		// Stat-gated: read at startup, from the /update command, and by the
		// auto-update tip provider. Spread at this boundary — the cached object
		// is shared, and update-and-write sequences build their next state
		// from what this returns.
		return { ...readJsonCached(path) } as AutoUpdateState
	} catch (err) {
		// readJson throws on malformed JSON (by design — corrupt configs should
		// be visible). Auto-update is non-critical, so swallow and return the
		// default state rather than crashing the session.
		const reason = err instanceof Error ? err.message : String(err)
		console.warn(`[kimchi-update] Ignoring malformed auto-update state at ${path}: ${reason}`)
		return {}
	}
}

/** Default for autoUpdate is `true` (opt-out). Only an explicit `false`
 *  disables it. Fails open on a malformed file or non-boolean value: the
 *  file is machine-written by /update, so bad content means corruption, not
 *  intent, and failing closed would silently strand users on old versions.
 *  The launch path still waits for the one-time notice (see auto-update.ts). */
export function loadAutoUpdateSetting(): boolean {
	const path = autoUpdateStatePath()
	const state = readState(path)
	if (state.autoUpdate === undefined) return true
	if (typeof state.autoUpdate !== "boolean") {
		console.warn(`[kimchi-update] Ignoring non-boolean autoUpdate value in ${path}; using the default (on).`)
		return true
	}
	return state.autoUpdate
}

/** Default for the one-time onboarding toast is `false` — we haven't shown it yet. */
export function loadAutoUpdateNoticeShown(): boolean {
	return readState(autoUpdateStatePath()).autoUpdateNoticeShown === true
}

/** Turning auto-update on explicitly also counts as having seen the
 *  onboarding notice: the user already knows, and the launch path waits
 *  for that notice before its first update (see auto-update.ts). */
export function saveAutoUpdateSetting(enabled: boolean): void {
	const path = autoUpdateStatePath()
	const next: AutoUpdateState = { ...readState(path), autoUpdate: enabled }
	if (enabled) next.autoUpdateNoticeShown = true
	writeJson(path, next)
}

export function markAutoUpdateNoticeShown(): void {
	const path = autoUpdateStatePath()
	const next = { ...readState(path), autoUpdateNoticeShown: true }
	writeJson(path, next)
}
