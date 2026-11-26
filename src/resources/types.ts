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
	/**
	 * An org FORCE_OFF on this resource also locks this one off, as long as
	 * this one has no org policy of its own. A feature that moved to a new id
	 * needs this: existing org policies only name the old id.
	 */
	inheritsOrgForceOffFrom?: ResourceId
}

export interface ResourceSettings {
	resources: Partial<Record<ResourceId, boolean>>
}

export interface ListedResourceSetting {
	id: ResourceId
	enabled: boolean
	overridden: true
}
