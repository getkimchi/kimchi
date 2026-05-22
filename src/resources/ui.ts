import { type Theme, getSettingsListTheme } from "@earendil-works/pi-coding-agent"
import { Key, type SettingItem, SettingsList, type TUI, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import { RESOURCE_KINDS, getResourceDefinitions, getResourcesByKind } from "./definitions.js"
import { isResourceEnabled, setResourceOverride } from "./store.js"
import type { ResourceKind } from "./types.js"

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
		add(` ${this.theme.fg("text", "Kimchi resources")}`)
		lines.push("")
		add(` ${this.renderTabs()}`)
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
				this.list.updateValue(id, value)
			},
			this.done,
			{ enableSearch: false },
		)
	}

	private renderTabs(): string {
		return TABS.map((tab) => {
			const label = tabLabel(tab)
			const count = enabledCount(tab)
			const text = ` ${label} ${count} `
			return tab === this.activeTab
				? this.theme.bg("selectedBg", this.theme.fg("text", text))
				: this.theme.fg("muted", text)
		}).join(" ")
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
			label: `${kindPrefix(resource.kind, tab)}${resource.label}`,
			description: `${resource.id} - ${resource.description}${resource.restartRequired ? " Restart required." : ""}`,
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
	return `${tabLabel(kind)} / `
}

function tabLabel(tab: ResourceTab): string {
	if (tab === "all") return "All"
	return tab.slice(0, 1).toUpperCase() + tab.slice(1)
}
