import { type Theme, getSettingsListTheme } from "@earendil-works/pi-coding-agent"
import { Key, type SettingItem, SettingsList, type TUI, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import { RESOURCE_KINDS, getResourceDefinitions, getResourcesByKind } from "./definitions.js"
import { isResourceEnabled, setResourceOverride } from "./store.js"
import type { ResourceDefinition, ResourceKind } from "./types.js"

const VALUE_ENABLED = "enabled"
const VALUE_DISABLED = "disabled"

type ResourceTab = ResourceKind | "all"

const TABS: readonly ResourceTab[] = ["all", ...RESOURCE_KINDS]

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

	private createList(): SettingsList {
		return new SettingsList(
			resourceItems(this.activeTab),
			12,
			getSettingsListTheme(),
			(id, value) => {
				setResourceOverride(id, value === VALUE_ENABLED)
				this.list = this.createList()
				this.tui.requestRender()
			},
			this.done,
			{ enableSearch: false },
		)
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
		const enabledText = this.theme.fg("success", `${enabled} enabled`)
		const disabledText =
			disabled > 0 ? this.theme.fg("warning", `${disabled} disabled`) : this.theme.fg("dim", "0 disabled")
		const restartText =
			restarts > 0 ? this.theme.fg("muted", `${restarts} restart-gated`) : this.theme.fg("dim", "live")
		return this.theme.fg("dim", "· ") + [enabledText, disabledText, restartText].join(this.theme.fg("dim", " · "))
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
	return getResourceDefinitions()
		.filter((resource) => tab === "all" || resource.kind === tab)
		.map((resource) => ({
			id: resource.id,
			label: resourceLabel(resource, tab),
			description: resourceDescription(resource),
			currentValue: isResourceEnabled(resource.id) ? VALUE_ENABLED : VALUE_DISABLED,
			values: [VALUE_ENABLED, VALUE_DISABLED],
		}))
}

function enabledCount(tab: ResourceTab): string {
	const resources = tab === "all" ? getResourceDefinitions() : getResourcesByKind(tab)
	const enabled = resources.filter((resource) => isResourceEnabled(resource.id)).length
	return `${enabled}/${resources.length}`
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
	}
}

function resourceLabel(resource: ResourceDefinition, tab: ResourceTab): string {
	const status = isResourceEnabled(resource.id) ? "●" : "○"
	const restart = resource.restartRequired ? " ↻" : ""
	return `${status} ${kindPrefix(resource.kind, tab)}${resource.label}${restart}`
}

function resourceDescription(resource: ResourceDefinition): string {
	const scope = resource.restartRequired ? "Applies after restart." : "Applies immediately."
	return `${resource.id} — ${scope} ${resource.description}`
}
