export const RESOURCE_KINDS = ["hooks", "extensions", "tools", "plugins"] as const

export type ResourceKind = (typeof RESOURCE_KINDS)[number]
export type ResourceId = `${ResourceKind}.${string}`

export interface ResourceDefinition {
	id: string
	kind: ResourceKind
	label: string
	description: string
	defaultEnabled: boolean
	restartRequired?: boolean
}

export interface ResourceSettings {
	resources: Partial<Record<ResourceId, boolean>>
}

export interface ListedResourceSetting {
	id: ResourceId
	enabled: boolean
	overridden: true
}
