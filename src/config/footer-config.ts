import { homedir } from "node:os"
import { join } from "node:path"
import { readJson, writeJson } from "./json.js"

export type FooterElementId =
	| "permissions"
	| "model"
	| "ferment"
	| "agents"
	| "context"
	| "usage"
	| "phase"
	| "tags"
	| "team"

export type FooterConfig = { pinned: FooterElementId[] }

const FOOTER_KEY = "footer"

export const DEFAULT_FOOTER_PINNED: FooterElementId[] = ["agents", "context", "usage"]

/** All footer elements for the settings UI.
 *  canPin=false marks elements that are always visible and cannot be toggled. */
export const FOOTER_ELEMENTS: Array<{
	id: FooterElementId
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
]

function getSettingsPath(): string {
	return join(homedir(), ".config", "kimchi", "harness", "settings.json")
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

let _config: FooterConfig | null = null

/** Reset the in-memory config cache. Exposed for test isolation only. */
export function _invalidateFooterConfigCache(): void {
	_config = null
}

export function readFooterConfig(): FooterConfig {
	if (_config !== null) return _config
	const settings = readJson(getSettingsPath())
	if (!(FOOTER_KEY in settings)) {
		_config = { pinned: [...DEFAULT_FOOTER_PINNED] }
		return _config
	}
	const raw = asRecord(settings[FOOTER_KEY])
	const pinned = Array.isArray(raw.pinned)
		? raw.pinned.filter((v): v is FooterElementId => FOOTER_ELEMENTS.some((e) => e.id === v))
		: []
	_config = { pinned }
	return _config
}

export function writeFooterConfig(config: FooterConfig): void {
	const path = getSettingsPath()
	const settings = readJson(path)
	settings[FOOTER_KEY] = config
	writeJson(path, settings)
	_config = { pinned: [...config.pinned] }
}

export function setPinned(id: FooterElementId, pinned: boolean): void {
	const current = readFooterConfig()
	const set = new Set(current.pinned)
	if (pinned) {
		set.add(id)
	} else {
		set.delete(id)
	}
	writeFooterConfig({ pinned: [...set] })
}

export function isPinned(id: FooterElementId): boolean {
	return readFooterConfig().pinned.includes(id)
}
