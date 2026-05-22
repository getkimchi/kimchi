import { type Theme, getSettingsListTheme } from "@earendil-works/pi-coding-agent"
import { type SettingItem, SettingsList, type TUI } from "@earendil-works/pi-tui"
import { RESOURCE_KINDS, getResourceDefinitions } from "./definitions.js"
import { isResourceEnabled, setResourceOverride } from "./store.js"
import type { ResourceKind } from "./types.js"

const VALUE_ENABLED = "enabled"
const VALUE_DISABLED = "disabled"

export class ResourceManagerComponent {
	private readonly list: SettingsList

	constructor(_theme: Theme, done: () => void, kind?: ResourceKind) {
		this.list = new SettingsList(
			resourceItems(kind),
			14,
			getSettingsListTheme(),
			(id, value) => {
				setResourceOverride(id, value === VALUE_ENABLED)
				this.list.updateValue(id, value)
			},
			done,
			{ enableSearch: true },
		)
	}

	render(width: number): string[] {
		return this.list.render(width)
	}

	handleInput(data: string): void {
		this.list.handleInput(data)
	}

	invalidate(): void {
		this.list.invalidate()
	}
}

export function createResourceManager(
	_tui: TUI,
	theme: Theme,
	done: () => void,
	kind?: ResourceKind,
): ResourceManagerComponent {
	return new ResourceManagerComponent(theme, done, kind)
}

function resourceItems(kind?: ResourceKind): SettingItem[] {
	return getResourceDefinitions()
		.filter((resource) => !kind || resource.kind === kind)
		.map((resource) => ({
			id: resource.id,
			label: `${kindPrefix(resource.kind, kind)}${resource.label}`,
			description: `${resource.id} - ${resource.description}${resource.restartRequired ? " Restart required." : ""}`,
			currentValue: isResourceEnabled(resource.id) ? VALUE_ENABLED : VALUE_DISABLED,
			values: [VALUE_ENABLED, VALUE_DISABLED],
		}))
}

function kindPrefix(kind: ResourceKind, filteredKind?: ResourceKind): string {
	if (filteredKind) return ""
	return `${kindLabel(kind)} / `
}

function kindLabel(kind: ResourceKind): string {
	const label = RESOURCE_KINDS.includes(kind) ? kind : "resources"
	return label.slice(0, 1).toUpperCase() + label.slice(1)
}
