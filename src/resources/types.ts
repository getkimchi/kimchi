// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
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
}

export interface ListedResourceSetting {
	id: ResourceId
	enabled: boolean
	overridden: true
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
