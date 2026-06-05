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

export const FOOTER_ELEMENTS: Array<{
	id: FooterElementId
	label: string
	description: string
}> = [
	{
		id: "permissions",
		label: "Permissions mode",
		description: "● default / ○ auto  → shift+tab",
	},
	{
		id: "model",
		label: "Model",
		description: "Active model or multi-model  → ctrl+p",
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

export function readFooterConfig(): FooterConfig {
	const settings = readJson(getSettingsPath())
	const raw = asRecord(settings[FOOTER_KEY])
	const pinned = Array.isArray(raw.pinned) ? raw.pinned.filter((v): v is FooterElementId => typeof v === "string") : []
	return { pinned }
}

export function writeFooterConfig(config: FooterConfig): void {
	const path = getSettingsPath()
	const settings = readJson(path)
	if (config.pinned.length > 0) {
		settings[FOOTER_KEY] = config
	} else {
		delete settings[FOOTER_KEY]
	}
	writeJson(path, settings)
}

export function setPinned(id: FooterElementId, pinned: boolean): void {
	const config = readFooterConfig()
	const set = new Set(config.pinned)
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
