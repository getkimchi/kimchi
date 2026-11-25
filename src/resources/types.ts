export const RESOURCE_KINDS = ["hooks", "extensions", "tools", "plugins", "skills"] as const

export type ResourceKind = (typeof RESOURCE_KINDS)[number]
export type ResourceId = `${ResourceKind}.${string}`

export interface ResourceDefinition {
	id: string
	kind: ResourceKind
	experimental?: boolean
	label: string
	description: string
	defaultEnabled: boolean
	restartRequired?: boolean
}

export interface ResourceSettings {
	resources: Partial<Record<ResourceId, boolean>>
	/** `false` turns off every resource not set to `true` in `resources`. */
	resourcesDefault?: false
}

export interface ListedResourceSetting {
	id: ResourceId
	enabled: boolean
	overridden: true
}
