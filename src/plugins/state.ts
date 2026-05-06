import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

const KIMCHI_CONFIG_PATH = resolve(homedir(), ".config", "kimchi", "config.json")

export interface PluginEntry {
	enabled: boolean
	source: "bundled" | "path"
	path?: string
}

export type PluginState = Record<string, PluginEntry>

export function readPluginState(configPath?: string): PluginState {
	const path = configPath ?? KIMCHI_CONFIG_PATH
	try {
		const raw = readFileSync(path, "utf-8")
		const parsed = JSON.parse(raw)
		if (parsed.plugins && typeof parsed.plugins === "object" && !Array.isArray(parsed.plugins)) {
			return parsed.plugins as PluginState
		}
		return {}
	} catch {
		return {}
	}
}

export function setPluginEnabled(
	name: string,
	enabled: boolean,
	source: "bundled" | "path",
	configPath?: string,
	path?: string,
): void {
	const resolvedPath = configPath ?? KIMCHI_CONFIG_PATH
	let raw: Record<string, unknown> = {}
	try {
		raw = JSON.parse(readFileSync(resolvedPath, "utf-8")) as Record<string, unknown>
	} catch {
		// file missing or invalid — start fresh
	}
	const existingPlugins = (
		raw.plugins && typeof raw.plugins === "object" && !Array.isArray(raw.plugins) ? raw.plugins : {}
	) as Record<string, unknown>
	raw.plugins = {
		...existingPlugins,
		[name]: { enabled, source, ...(path ? { path } : {}) },
	}
	mkdirSync(dirname(resolvedPath), { recursive: true })
	const tmp = `${resolvedPath}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf-8")
	renameSync(tmp, resolvedPath)
}
