// Persistence for the harness auto-update toggle.
// - File: ~/.config/kimchi/harness/settings.json (via getAgentDir())
// - Defaults to `false` (opt-in) for the initial rollout; will flip to
//   `true` (opt-out) to match Claude Code's native-install default once
//   the rollout is validated. See loadAutoUpdateSetting() for details.
// - Defensive sanitize: wrong types → default; corrupt JSON → warn + default
// - Atomic write: tmp file + rename so a crash mid-write never corrupts settings

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"

function settingsPath(): string {
	return join(getAgentDir(), "settings.json")
}

function readRaw(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
		// File exists but isn't a JSON object → treat as empty, don't warn.
		// Only truly malformed JSON triggers a warning.
		return {}
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err)
		console.warn(`[kimchi-update] Ignoring malformed settings at ${path}: ${reason}`)
		return {}
	}
}

/** Default for autoUpdate is `false` (opt-in) for the initial rollout.
 *  Plan: ship opt-in first, monitor for regressions, then flip to `true`
 *  (opt-out) to match Claude Code's native-install default. */
export function loadAutoUpdateSetting(): boolean {
	const raw = readRaw(settingsPath())
	// Missing or wrong type → opt-in default. Only an explicit `true` opts in.
	if (typeof raw.autoUpdate !== "boolean") return false
	return raw.autoUpdate
}

/** Default for the one-time onboarding toast is `false` — we haven't shown it yet. */
export function loadAutoUpdateNoticeShown(): boolean {
	const raw = readRaw(settingsPath())
	return raw.autoUpdateNoticeShown === true
}

/** Atomic write: tmp file + rename. Preserves all other keys in the file. */
function writeRaw(path: string, next: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.tmp`
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8")
	renameSync(tmp, path)
}

export function saveAutoUpdateSetting(enabled: boolean): void {
	const path = settingsPath()
	const next = { ...readRaw(path), autoUpdate: enabled }
	writeRaw(path, next)
}

export function markAutoUpdateNoticeShown(): void {
	const path = settingsPath()
	const next = { ...readRaw(path), autoUpdateNoticeShown: true }
	writeRaw(path, next)
}
