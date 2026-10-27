import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent"
import {
	Key,
	matchesKey,
	type SettingItem,
	SettingsList,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui"
import type { ResourcePolicy } from "../api/org-settings.js"
import { getResourceDefinitions, getResourcesByKind } from "./definitions.js"
import {
	describeOrgLock,
	getResourcePolicy,
	isResourceEnabled,
	isResourceLocked,
	setResourceOverride,
} from "./store.js"
import type { ResourceDefinition, ResourceKind } from "./types.js"
import { RESOURCE_KINDS } from "./types.js"

const VALUE_ENABLED = "enabled"
const VALUE_DISABLED = "disabled"

type ResourceTab = ResourceKind | "all" | "experimental"

const TABS: readonly ResourceTab[] = ["all", ...RESOURCE_KINDS, "experimental"]

export class ResourceManagerComponent {
	private list: SettingsList
	private activeTab: ResourceTab

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
		initialKind?: ResourceKind,
	) {
		this.activeTab = initialKind ?? "all"
		this.list = this.createList()
	}

	render(width: number): string[] {
		const lines: string[] = []
		const add = (line: string) => lines.push(truncateToWidth(line, width))

		add(this.theme.fg("accent", "─".repeat(width)))
		add(` ${this.theme.bold(this.theme.fg("text", "Kimchi resources"))} ${this.renderSummary()}`)
		lines.push("")
		add(` ${this.renderTabs()}`)
		add(` ${this.theme.fg("dim", tabDescription(this.activeTab))}`)
		lines.push("")
		for (const line of this.list.render(width)) add(line)
		lines.push("")
		add(this.theme.fg("dim", " Tab/←→ switch tabs · Enter/Space toggle · Esc close"))
		add(this.theme.fg("accent", "─".repeat(width)))
		return lines
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.selectRelativeTab(1)
			return
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.selectRelativeTab(-1)
			return
		}
		this.list.handleInput(data)
	}

	invalidate(): void {
		this.list.invalidate()
	}

	private selectRelativeTab(delta: number): void {
		const current = TABS.indexOf(this.activeTab)
		this.activeTab = TABS[(current + delta + TABS.length) % TABS.length]
		this.list = this.createList()
		this.tui.requestRender()
	}

	private createList(selectedId?: string): SettingsList {
		const items = resourceItems(this.activeTab)
		const list = new SettingsList(
			items,
			12,
			getSettingsListTheme(),
			(id, value) => {
				setResourceOverride(id, value === VALUE_ENABLED)
				this.list = this.createList(id)
				this.tui.requestRender()
			},
			this.done,
			{ enableSearch: false },
		)
		setSelectedResource(list, items, selectedId)
		return list
	}

	private renderTabs(): string {
		return TABS.map((tab) => {
			const label = tabLabel(tab)
			const count = enabledCount(tab)
			const text = ` ${tabIcon(tab)} ${label} ${count} `
			return tab === this.activeTab
				? this.theme.bg("selectedBg", this.theme.fg("text", text))
				: this.theme.fg("muted", text)
		}).join(" ")
	}

	private renderSummary(): string {
		const resources = getResourceDefinitions()
		const enabled = resources.filter((resource) => isResourceEnabled(resource.id)).length
		const disabled = resources.length - enabled
		const restarts = resources.filter((resource) => resource.restartRequired && isResourceEnabled(resource.id)).length
		const locked = resources.filter((resource) => isResourceLocked(resource.id)).length
		const enabledText = this.theme.fg("success", `${enabled} enabled`)
		const disabledText =
			disabled > 0 ? this.theme.fg("warning", `${disabled} disabled`) : this.theme.fg("dim", "0 disabled")
		const restartText =
			restarts > 0 ? this.theme.fg("muted", `${restarts} restart-gated`) : this.theme.fg("dim", "live")
		const parts = [enabledText, disabledText, restartText]
		if (locked > 0) parts.push(this.theme.fg("warning", `${locked} org-locked`))
		return this.theme.fg("dim", "· ") + parts.join(this.theme.fg("dim", " · "))
	}
}

export function createResourceManager(
	tui: TUI,
	theme: Theme,
	done: () => void,
	kind?: ResourceKind,
): ResourceManagerComponent {
	return new ResourceManagerComponent(tui, theme, done, kind)
}

function resourceItems(tab: ResourceTab): SettingItem[] {
	const rows = resourcesForTab(tab).map((resource) => {
		const locked = isResourceLocked(resource.id)
		return {
			id: resource.id,
			label: resourceLabel(resource, tab),
			description: resourceDescription(resource, locked),
			currentValue: resourceValue(resource, locked),
			// Org-locked rows carry no toggle values: SettingsList treats an
			// item without `values` as inert on Enter/Space, so the locked state
			// cannot be changed from the list.
			values: locked ? undefined : [VALUE_ENABLED, VALUE_DISABLED],
		}
	})
	// Pad every label to one shared visible width so the value column starts
	// at the same column in every row. SettingsList only pads up to a
	// 36-column cap, which these labels overflow.
	const width = Math.max(...rows.map((row) => visibleWidth(row.label)))
	return rows.map((row) => ({ ...row, label: row.label + " ".repeat(Math.max(0, width - visibleWidth(row.label))) }))
}

function enabledCount(tab: ResourceTab): string {
	const resources = resourcesForTab(tab)
	const enabled = resources.filter((resource) => isResourceEnabled(resource.id)).length
	return `${enabled}/${resources.length}`
}

function resourcesForTab(tab: ResourceTab): ResourceDefinition[] {
	if (tab === "all") return getResourceDefinitions()
	if (tab === "experimental") return getResourceDefinitions().filter((resource) => resource.experimental)
	return getResourcesByKind(tab).filter((resource) => !resource.experimental)
}

function kindPrefix(kind: ResourceKind, tab: ResourceTab): string {
	if (tab !== "all") return ""
	return `${tabIcon(kind)} ${tabLabel(kind)} / `
}

function tabLabel(tab: ResourceTab): string {
	if (tab === "all") return "All"
	return tab.slice(0, 1).toUpperCase() + tab.slice(1)
}

function tabIcon(tab: ResourceTab): string {
	switch (tab) {
		case "all":
			return "◆"
		case "hooks":
			return "↯"
		case "tools":
			return "⌘"
		case "extensions":
			return "▣"
		case "plugins":
			return "◈"
		case "skills":
			return "⧉"
		case "experimental":
			return "✦"
	}
}

function tabDescription(tab: ResourceTab): string {
	switch (tab) {
		case "all":
			return "Every controllable Kimchi capability in one place."
		case "hooks":
			return "Command interceptors and rewrite/block hooks."
		case "tools":
			return "Model-callable tools exposed to the agent."
		case "extensions":
			return "Built-in Kimchi feature modules."
		case "plugins":
			return "External connector and package surfaces."
		case "skills":
			return "Bundled Kimchi skills."
		case "experimental":
			return "Opt-in Kimchi features that are still experimental."
	}
}

function resourceLabel(resource: ResourceDefinition, tab: ResourceTab): string {
	const status = isResourceEnabled(resource.id) ? "●" : "○"
	const restart = resource.restartRequired ? " ↻" : ""
	return `${status} ${kindPrefix(resource.kind, tab)}${resource.label}${restart}`
}

/** The effective state, plus who controls it when the org locks the resource. */
function resourceValue(resource: ResourceDefinition, locked: boolean): string {
	const state = isResourceEnabled(resource.id) ? VALUE_ENABLED : VALUE_DISABLED
	return locked ? `${state} (org-locked)` : state
}

function resourceDescription(resource: ResourceDefinition, locked: boolean): string {
	const scope = resource.restartRequired ? "Applies after restart." : "Applies immediately."
	const managed = locked ? ` ${orgLockNote(getResourcePolicy(resource.id))}` : ""
	return `${resource.id} — ${scope} ${resource.description}${managed}`
}

/** Human phrasing for the forced policy — raw enum names are API values. */
function orgLockNote(policy: ResourcePolicy | undefined): string {
	if (policy === "FORCE_ON" || policy === "FORCE_OFF") {
		const tail = policy === "FORCE_ON" ? "it cannot be disabled locally" : "it cannot be enabled locally"
		return `Managed by your organization: ${describeOrgLock(policy)} (${tail}).`
	}
	return ""
}

function setSelectedResource(list: SettingsList, items: SettingItem[], id: string | undefined): void {
	if (!id) return
	const index = items.findIndex((item) => item.id === id)
	if (index < 0) return
	const target = selectedIndexTarget(list)
	if (!target) return
	target.selectedIndex = index
}

type SelectedIndexTarget = { selectedIndex: number }

function selectedIndexTarget(list: SettingsList): SelectedIndexTarget | undefined {
	const candidate = list as unknown
	if (!isRecord(candidate)) return undefined
	if (typeof candidate.selectedIndex !== "number") return undefined
	const descriptor = propertyDescriptor(candidate, "selectedIndex")
	if (descriptor?.writable !== true && descriptor?.set === undefined) return undefined
	return candidate as unknown as SelectedIndexTarget
}

function propertyDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
	let current: object | null = value
	while (current) {
		const descriptor = Object.getOwnPropertyDescriptor(current, key)
		if (descriptor) return descriptor
		current = Object.getPrototypeOf(current)
	}
	return undefined
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return value !== null && typeof value === "object"
}
