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
	| "lsp"
	| "dap"

export type StatusLineConfig = { pinned: StatusLineElementId[]; hidden: StatusLineElementId[] }

const STATUS_LINE_KEY = "statusLine"

export const DEFAULT_STATUS_LINE_PINNED: StatusLineElementId[] = ["thinking", "agents", "context", "usage"]

export interface StatusLineElement {
	id: StatusLineElementId
	label: string
	description: string
	/** Always visible, cannot be toggled. */
	canPin?: boolean
	/** Renders whenever its data exists (no pin needed); the /customize-status-line
	 *  toggle opts out via `hidden` instead of opting in via `pinned`. */
	defaultVisible?: boolean
}

/** All status line elements for the settings UI. */
export const STATUS_LINE_ELEMENTS: StatusLineElement[] = [
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
	{
		id: "lsp",
		label: "LSP",
		description: "Language-server state (detected / not installed / failed)",
		defaultVisible: true,
	},
	{
		id: "dap",
		label: "DAP",
		description: "Debug-adapter state (detected / not installed)",
		defaultVisible: true,
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

function isStatusLineElementId(value: unknown): value is StatusLineElementId {
	return typeof value === "string" && STATUS_LINE_ELEMENTS.some((element) => element.id === value)
}

function isDefaultVisibleElementId(value: unknown): value is StatusLineElementId {
	return STATUS_LINE_ELEMENTS.some((element) => element.defaultVisible === true && element.id === value)
}

function parseStatusLineConfig(settings: Record<string, unknown>): StatusLineConfig {
	if (!(STATUS_LINE_KEY in settings)) return { pinned: [...DEFAULT_STATUS_LINE_PINNED], hidden: [] }
	const raw = asRecord(settings[STATUS_LINE_KEY])
	const values = Array.isArray(raw.pinned) ? raw.pinned : []
	const pinned: StatusLineElementId[] = []
	for (const value of values) {
		if (value === "billing") {
			pinned.push("credits", "budget")
		} else if (isStatusLineElementId(value)) {
			pinned.push(value)
		}
	}
	const hiddenValues = Array.isArray(raw.hidden) ? raw.hidden : []
	// Only defaultVisible elements can be hidden — other ids here would be
	// silently inert, so drop them at parse time.
	const hidden = hiddenValues.filter(isDefaultVisibleElementId)
	return { pinned: [...new Set(pinned)], hidden: [...new Set(hidden)] }
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

function setListEntry(
	list: readonly StatusLineElementId[],
	id: StatusLineElementId,
	present: boolean,
): StatusLineElementId[] {
	const set = new Set(list)
	if (present) set.add(id)
	else set.delete(id)
	return [...set]
}

export function setStatusLineElementPinned(id: StatusLineElementId, pinned: boolean): void {
	const current = readStatusLineConfig()
	writeStatusLineConfig({ pinned: setListEntry(current.pinned, id, pinned), hidden: current.hidden })
}

export function isStatusLineElementPinned(id: StatusLineElementId): boolean {
	return readStatusLineConfig().pinned.includes(id)
}

/** Opt-out for defaultVisible elements: mark the element hidden. Existing
 *  configs without a `hidden` key keep every defaultVisible element shown. */
export function setStatusLineElementHidden(id: StatusLineElementId, hidden: boolean): void {
	const current = readStatusLineConfig()
	writeStatusLineConfig({ pinned: current.pinned, hidden: setListEntry(current.hidden, id, hidden) })
}

export function isStatusLineElementHidden(id: StatusLineElementId): boolean {
	return readStatusLineConfig().hidden.includes(id)
}

/** Effective visibility in /customize-status-line: defaultVisible elements
 *  show unless hidden; other (pinnable) elements show only when pinned. */
export function isStatusLineElementVisible(element: StatusLineElement, config: StatusLineConfig): boolean {
	return element.defaultVisible ? !config.hidden.includes(element.id) : config.pinned.includes(element.id)
}

/** Flip an element's visibility: defaultVisible elements toggle `hidden`,
 *  pinnable ones toggle `pinned`. */
export function toggleStatusLineElement(element: StatusLineElement): void {
	const config = readStatusLineConfig()
	if (element.defaultVisible) {
		setStatusLineElementHidden(element.id, !config.hidden.includes(element.id))
	} else {
		setStatusLineElementPinned(element.id, !config.pinned.includes(element.id))
	}
}
