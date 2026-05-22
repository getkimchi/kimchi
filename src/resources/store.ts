import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { readJson, writeJson } from "../config/json.js"
import { getResourceDefinition } from "./definitions.js"
import { type ListedResourceSetting, RESOURCE_KINDS, type ResourceId, type ResourceSettings } from "./types.js"

const SETTINGS_KEY = "resources"

export function getResourceSettingsPath(): string {
	return process.env.KIMCHI_CODING_AGENT_DIR
		? resolve(process.env.KIMCHI_CODING_AGENT_DIR, "settings.json")
		: join(homedir(), ".config", "kimchi", "harness", "settings.json")
}

export const settingsPath = getResourceSettingsPath

export function readResourceSettings(path = getResourceSettingsPath()): ResourceSettings {
	const settings = readJson(path)
	const raw = asRecord(settings[SETTINGS_KEY])
	const resources: ResourceSettings["resources"] = {}
	for (const [id, value] of Object.entries(raw)) {
		if (isResourceId(id) && typeof value === "boolean") resources[id] = value
	}
	return { resources }
}

export function getResourceOverride(id: string, path = getResourceSettingsPath()): boolean | undefined {
	assertResourceId(id)
	return readResourceSettings(path).resources[id]
}

export function isResourceEnabled(id: string, path = getResourceSettingsPath()): boolean {
	assertResourceId(id)
	const definition = getResourceDefinition(id)
	const fallback = definition?.defaultEnabled ?? true
	return getResourceOverride(id, path) ?? fallback
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
	if (enabled === undefined) delete resources[id]
	else resources[id] = enabled

	if (Object.keys(resources).length > 0) {
		settings[SETTINGS_KEY] = resources
	} else {
		delete settings[SETTINGS_KEY]
	}
	writeJson(path, settings)
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
