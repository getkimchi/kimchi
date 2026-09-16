import { homedir } from "node:os"
import { join } from "node:path"
import { invalidateJsonCache, readJson, readJsonCached, writeJson } from "./json.js"

export type StatusLineElementId =
	| "permissions"
	| "model"
	| "thinking"
	| "ferment"
	| "agents"
	| "context"
	| "usage"
	| "phase"
	| "tags"
	| "team"
	| "credits"
	| "budget"

export type StatusLineConfig = { pinned: StatusLineElementId[] }

const STATUS_LINE_KEY = "statusLine"

export const DEFAULT_STATUS_LINE_PINNED: StatusLineElementId[] = ["thinking", "agents", "context", "usage"]

/** All status line elements for the settings UI.
 *  canPin=false marks elements that are always visible and cannot be toggled. */
export const STATUS_LINE_ELEMENTS: Array<{
	id: StatusLineElementId
	label: string
	description: string
	canPin?: boolean
}> = [
	{
		id: "permissions",
		label: "Permissions mode",
		description: "● default / ○ auto  → shift+tab",
		canPin: false,
	},
	{
		id: "model",
		label: "Model",
		description: "Active model or multi-model  → ctrl+p",
		canPin: false,
	},
	{
		id: "thinking",
		label: "Thinking level",
		description: "Current model thinking level",
	},
	{
		id: "ferment",
		label: "Ferment",
		description: "Ferment status & controls",
	},
	{
		id: "agents",
		label: "Agents",
		description: "Active sub-agent count",
	},
	{
		id: "context",
		label: "Context",
		description: "Context usage bar + percentage",
	},
	{
		id: "usage",
		label: "Token I/O",
		description: "Token input (↑) and output (↓)",
	},
	{
		id: "phase",
		label: "Phase",
		description: "Current work phase",
	},
	{
		id: "tags",
		label: "Tags",
		description: "Active tags (env:, region: …)",
	},
	{
		id: "team",
		label: "Team",
		description: "Team tag value",
	},
	{
		id: "credits",
		label: "Credits",
		description: "Remaining credit balance",
	},
	{
		id: "budget",
		label: "Budget",
		description: "Budget usage and limit",
	},
]

function getSettingsPath(): string {
	return join(homedir(), ".config", "kimchi", "harness", "settings.json")
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Drop the cached settings read. Exposed for test isolation only. */
export function _invalidateStatusLineConfigCache(): void {
	invalidateJsonCache(getSettingsPath())
}

function parseStatusLineConfig(settings: Record<string, unknown>): StatusLineConfig {
	if (!(STATUS_LINE_KEY in settings)) return { pinned: [...DEFAULT_STATUS_LINE_PINNED] }
	const raw = asRecord(settings[STATUS_LINE_KEY])
	const values = Array.isArray(raw.pinned) ? raw.pinned : []
	const pinned: StatusLineElementId[] = []
	for (const value of values) {
		if (value === "billing") {
			pinned.push("credits", "budget")
		} else if (STATUS_LINE_ELEMENTS.some((element) => element.id === value)) {
			pinned.push(value as StatusLineElementId)
		}
	}
	return { pinned: [...new Set(pinned)] }
}

export function readStatusLineConfig(): StatusLineConfig {
	// Stat-gated read: the status line renders on every frame, so the file
	// is only re-read when its mtime/size signature changes — unlike the
	// previous process-lifetime cache, external edits are now picked up too.
	return parseStatusLineConfig(readJsonCached(getSettingsPath()))
}

export function writeStatusLineConfig(config: StatusLineConfig): void {
	const path = getSettingsPath()
	// Raw read: this is a read-modify-write of the shared settings file.
	const settings = readJson(path)
	settings[STATUS_LINE_KEY] = config
	writeJson(path, settings)
}

export function setStatusLineElementPinned(id: StatusLineElementId, pinned: boolean): void {
	const current = readStatusLineConfig()
	const set = new Set(current.pinned)
	if (pinned) {
		set.add(id)
	} else {
		set.delete(id)
	}
	writeStatusLineConfig({ pinned: [...set] })
}

export function isStatusLineElementPinned(id: StatusLineElementId): boolean {
	return readStatusLineConfig().pinned.includes(id)
}
