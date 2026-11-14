import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { readJson, readJsonCached, writeJson } from "../../config/json.js"

function settingsPath(): string {
	return join(getAgentDir(), "pr-watch.json")
}

export function readPRWatchPreference(): boolean | undefined {
	try {
		const value = readJsonCached(settingsPath()).enabled
		return typeof value === "boolean" ? value : undefined
	} catch {
		return undefined
	}
}

export function writePRWatchPreference(enabled: boolean): void {
	const path = settingsPath()
	// Refuse malformed state instead of overwriting it with a new decision.
	writeJson(path, { ...readJson(path), enabled })
}
