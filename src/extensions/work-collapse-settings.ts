import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * "Collapse work" setting — folds completed agent work (tool calls and,
 * in "all" mode, interstitial assistant commentary) into a single
 * "Worked for Xs" row.
 *
 * Modes:
 *  - "all":   fold tool calls AND interstitial assistant commentary (default)
 *  - "tools": fold tool calls only; assistant text and thinking stay visible
 *  - "off":   classic rendering, nothing folds
 *
 * Booleans are accepted for convenience: true → "all", false → "off".
 * Resolution order: project `.kimchi/settings.json` overrides the global
 * harness `settings.json`; a missing/invalid key defaults to "all".
 */

export type CollapseWorkMode = "all" | "tools" | "off"

const SETTINGS_KEY = "collapseWork"
const SETTINGS_CACHE_TTL_MS = 5_000

export function getAgentDir(): string {
	return process.env.KIMCHI_CODING_AGENT_DIR ?? join(homedir(), ".config", "kimchi", "harness")
}

export function parseCollapseWorkMode(value: unknown): CollapseWorkMode | undefined {
	if (value === true) return "all"
	if (value === false) return "off"
	if (typeof value !== "string") return undefined
	const normalized = value.trim().toLowerCase()
	if (normalized === "all" || normalized === "everything") return "all"
	if (normalized === "tools" || normalized === "semi" || normalized === "tools-only") return "tools"
	if (normalized === "off" || normalized === "false" || normalized === "none") return "off"
	return undefined
}

function readModeFromFile(path: string): CollapseWorkMode | undefined {
	if (!existsSync(path)) return undefined
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
		if (!raw || typeof raw !== "object") return undefined
		return parseCollapseWorkMode((raw as Record<string, unknown>)[SETTINGS_KEY])
	} catch {
		// Tolerate unreadable/invalid settings files — the default applies.
		return undefined
	}
}

interface CollapseWorkCache {
	value: CollapseWorkMode
	timestamp: number
	cwd: string
}

let cache: CollapseWorkCache | undefined

export function readCollapseWorkMode(cwd: string, now = Date.now()): CollapseWorkMode {
	if (cache && cache.cwd === cwd && now - cache.timestamp < SETTINGS_CACHE_TTL_MS) {
		return cache.value
	}
	const globalValue = readModeFromFile(join(getAgentDir(), "settings.json"))
	const projectValue = readModeFromFile(join(cwd, ".kimchi", "settings.json"))
	const value = projectValue ?? globalValue ?? "all"
	cache = { value, timestamp: now, cwd }
	return value
}

/** Persist the mode to the global harness settings.json (merged into existing content). */
export function writeCollapseWorkMode(mode: CollapseWorkMode): void {
	const path = join(getAgentDir(), "settings.json")
	let settings: Record<string, unknown> = {}
	try {
		if (existsSync(path)) {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = parsed as Record<string, unknown>
			}
		}
	} catch {
		settings = {}
	}
	settings[SETTINGS_KEY] = mode
	try {
		writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
	} finally {
		resetCollapseWorkCache()
	}
}

export function resetCollapseWorkCache(): void {
	cache = undefined
}
