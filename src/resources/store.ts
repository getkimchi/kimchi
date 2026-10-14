import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { readJson, readJsonCached, writeJson } from "../config/json.js"
import { getResourceDefinition } from "./definitions.js"
import {
	type ListedResourceSetting,
	RESOURCE_KINDS,
	type ResourceId,
	type ResourceSettings,
	TERMINAL_RECORDING_RESOURCE_ID,
} from "./types.js"

const SETTINGS_KEY = "resources"
const recordingListeners = new Set<(path: string) => void>()

/** Apply recording toggles in this TUI without reloading its session or watching settings files. */
export function onTerminalRecordingChange(listener: (path: string) => void): () => void {
	recordingListeners.add(listener)
	return () => recordingListeners.delete(listener)
}

export function getResourceSettingsPath(): string {
	return process.env.KIMCHI_CODING_AGENT_DIR
		? resolve(process.env.KIMCHI_CODING_AGENT_DIR, "settings.json")
		: join(homedir(), ".config", "kimchi", "harness", "settings.json")
}

export const settingsPath = getResourceSettingsPath

export function readResourceSettings(path = getResourceSettingsPath()): ResourceSettings {
	// Stat-gated cache: isResourceEnabled is consulted on every bash tool_call
	// and every hook event, so the common case must not re-read and re-parse
	// the settings file. The parsed object is shared — only read from it.
	const settings = readJsonCached(path)
	const raw = asRecord(settings[SETTINGS_KEY])
	const resources: ResourceSettings["resources"] = {}
	for (const [id, value] of Object.entries(raw)) {
		if (isResourceId(id) && typeof value === "boolean") resources[id] = value
	}
	// Keep the existing setting authoritative; the resource is another way to edit it.
	if (typeof settings.terminalRecording === "boolean")
		resources[TERMINAL_RECORDING_RESOURCE_ID] = settings.terminalRecording
	return { resources }
}

export function getResourceOverride(id: string, path = getResourceSettingsPath()): boolean | undefined {
	assertResourceId(id)
	return readResourceSettings(path).resources[id]
}

export function isResourceEnabled(id: string, path = getResourceSettingsPath()): boolean {
	assertResourceId(id)
	const override = getResourceOverride(id, path)
	if (override !== undefined) return override
	if (envEnabledResources().has(id)) return true
	const definition = getResourceDefinition(id)
	const fallback = definition?.defaultEnabled ?? true
	return fallback
}

/**
 * Resource ids from KIMCHI_ENABLE_RESOURCES (comma-separated) — a transient,
 * per-invocation enablement layer for any resource. Malformed entries are
 * dropped rather than failing the session (the KIMCHI_TAGS fail-open
 * precedent); unknown ids are inert. A deliberate `resources disable` still
 * wins: the persistent override is checked first.
 */
function envEnabledResources(): Set<string> {
	const raw = process.env.KIMCHI_ENABLE_RESOURCES
	if (!raw) return new Set<string>()
	const ids = new Set<string>()
	for (const entry of raw.split(",")) {
		const trimmed = entry.trim()
		if (isResourceId(trimmed)) ids.add(trimmed)
	}
	return ids
}

export function listResourceSettings(path = getResourceSettingsPath()): ListedResourceSetting[] {
	return Object.entries(readResourceSettings(path).resources)
		.map(([id, enabled]) => ({ id: id as ResourceId, enabled: enabled ?? true, overridden: true as const }))
		.sort((a, b) => a.id.localeCompare(b.id))
}

export function setResourceOverride(id: string, enabled: boolean | undefined, path = getResourceSettingsPath()): void {
	assertResourceId(id)
	const settings = readJson(path)
	const resources = asRecord(settings[SETTINGS_KEY])
	if (id === TERMINAL_RECORDING_RESOURCE_ID) {
		settings.terminalRecording = enabled
		delete resources[id]
	} else if (enabled === undefined) delete resources[id]
	else resources[id] = enabled

	if (Object.keys(resources).length > 0) {
		settings[SETTINGS_KEY] = resources
	} else {
		delete settings[SETTINGS_KEY]
	}
	writeJson(path, settings)
	if (id === TERMINAL_RECORDING_RESOURCE_ID) {
		for (const listener of recordingListeners) {
			try {
				listener(resolve(path))
			} catch {
				// Optional live capture must not turn a successful settings write into a failure.
			}
		}
	}
}

export function resetResourceOverride(id: string, path = getResourceSettingsPath()): void {
	setResourceOverride(id, undefined, path)
}

function isResourceId(value: string): value is ResourceId {
	const dot = value.indexOf(".")
	if (dot <= 0 || dot === value.length - 1) return false
	return (RESOURCE_KINDS as readonly string[]).includes(value.slice(0, dot))
}

function assertResourceId(value: string): asserts value is ResourceId {
	if (!isResourceId(value)) throw new Error(`Invalid resource id "${value}". Expected "<kind>.<name>".`)
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
