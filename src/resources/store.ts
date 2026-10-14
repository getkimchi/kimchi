import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { ResourcePolicy } from "../api/org-settings.js"
import { readJson, readJsonCached, writeJson } from "../config/json.js"
import { getOrgPolicy } from "../org-policy.js"
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
	// Stat-gated cache: isResourceEnabled is consulted on every bash tool_call
	// and every hook event, so the common case must not re-read and re-parse
	// the settings file. The parsed object is shared — only read from it.
	const settings = readJsonCached(path)
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

/**
 * The org-policy entry for a resource, if any. The API treats map keys as
 * free-form resource ids, so the map may hold ids this harness does not
 * know; those are inert — they only matter when something asks about that
 * id by name, and then only if a definition or gate consults it.
 */
export function getResourcePolicy(id: string): ResourcePolicy | undefined {
	assertResourceId(id)
	return getOrgPolicy()?.resources?.[id]
}

/** Whether the org policy locks the resource (FORCE_ON / FORCE_OFF). */
export function isResourceLocked(id: string): boolean {
	const policy = getResourcePolicy(id)
	return policy === "FORCE_ON" || policy === "FORCE_OFF"
}

/**
 * Human wording for a forced policy — the raw FORCE_* enum names are API
 * values and mean nothing to users, so no user-facing surface prints them.
 */
export function describeOrgLock(policy: ResourcePolicy): "locked on" | "locked off" {
	return policy === "FORCE_ON" ? "locked on" : "locked off"
}

/**
 * The one org-lock refusal sentence, shared by every surface (store guard,
 * CLI, /resources command, ACP) so the wording cannot drift.
 */
export function orgLockMessage(id: string): string {
	const policy = getResourcePolicy(id)
	if (policy === "FORCE_ON") {
		return `${id} is ${describeOrgLock(policy)} by your organization; it cannot be disabled locally.`
	}
	if (policy === "FORCE_OFF") {
		return `${id} is ${describeOrgLock(policy)} by your organization; it cannot be enabled locally.`
	}
	return `${id} is managed by your organization; it cannot be changed locally.`
}

/**
 * Effective enablement. Precedence, highest first:
 *
 * 1. org FORCE_ON / FORCE_OFF — locked; beats every local choice
 * 2. local settings.json override — the user's persistent choice
 * 3. KIMCHI_ENABLE_RESOURCES env — a transient local choice
 * 4. org ON / OFF — soft defaults a local choice (2 or 3) may override
 * 5. the definition's defaultEnabled
 */
export function isResourceEnabled(id: string, path = getResourceSettingsPath()): boolean {
	assertResourceId(id)
	const orgPolicy = getResourcePolicy(id)
	if (orgPolicy === "FORCE_ON") return true
	if (orgPolicy === "FORCE_OFF") return false

	const override = getResourceOverride(id, path)
	if (override !== undefined) return override
	if (envEnabledResources().has(id)) return true

	if (orgPolicy === "ON") return true
	if (orgPolicy === "OFF") return false
	const definition = getResourceDefinition(id)
	return definition?.defaultEnabled ?? true
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
	// Fail closed on org-locked resources: while a lock is in force, no new
	// override entries are written, so choices made during the lock never
	// outlive it. Overrides written before the lock was applied are left in
	// place (they record the user's prior choice) but have no effect while the
	// lock holds — they resurface if the org later lifts the policy.
	if (isResourceLocked(id)) {
		throw new Error(orgLockMessage(id))
	}
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
