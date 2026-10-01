export type WorkspaceStatus = "active" | "idle" | "completed"

export interface Workspace {
	id: string
	name: string
	createdAt: Date
	lastActivityAt: Date
	status: WorkspaceStatus
	host?: string
	/** Pod CPU request in millicores (1500 = 1.5 vCPU). Provisioned size, not live utilization. */
	cpuMillicores?: number
	/** Pod memory request in bytes. Provisioned size, not live utilization. */
	ramBytes?: number
	/** Persistent-volume claim size in bytes. */
	pvcSizeBytes?: number
}

/**
 * Current consumption vs. limits for one quota scope (organization or user).
 * Mirrors the server's `ResourceUsage` proto message. Fields are optional so
 * partial responses from older control planes degrade gracefully.
 */
export interface ResourceUsage {
	/** Sandboxes (workspaces) currently counted against the quota. */
	currentSandboxes?: number
	maxSandboxes?: number
	currentCpuMillicores?: number
	maxCpuMillicores?: number
	currentRamBytes?: number
	maxRamBytes?: number
	/** Persistent-volume storage currently counted against the quota, in bytes. */
	currentPvcSizeBytes?: number
	/** Maximum persistent-volume storage allowed by the quota, in bytes. */
	maxPvcSizeBytes?: number
}

/** Org/user quota usage returned by the control plane's `quotas:usage` endpoint. */
export interface QuotaUsage {
	orgUsage?: ResourceUsage
	userUsage?: ResourceUsage
}

/**
 * Workspace resource requests — Kubernetes quantity strings
 * (e.g. "250m", "1Gi", "20Gi"). Carries both the raw form as authored in
 * `kimchi_workspace.yaml` and the validated/normalized form sent on the wire.
 */
export interface WorkspaceResourcesConfig {
	cpu?: string
	memory?: string
	pvcSize?: string
}

/** Field names accepted under `resources:` — single source of truth for file parsing and quantity validation. */
export const WORKSPACE_RESOURCE_FIELDS = ["cpu", "memory", "pvcSize"] as const

/** Field names accepted under `egressPolicy:` — single source of truth for file parsing and validation. */
export const EGRESS_POLICY_FIELDS = ["denyByDefault", "allowed", "denied"] as const

/**
 * Outbound network policy of a workspace, enforced by the in-pod sidekick
 * proxy. `denyByDefault` is tri-state: absent keeps the server's default
 * (fail-closed — only `allowed` destinations pass); explicit `false`
 * requests the default-allow posture. `denied` always wins over `allowed`.
 */
export interface EgressPolicyConfig {
	denyByDefault?: boolean
	allowed?: string[]
	denied?: string[]
}

/**
 * Create-time workspace parameters sent under `spec` on workspace upserts.
 * Mirrors the control-plane WorkspaceSpec message (workspaces_api.proto):
 * resources / dependencies / egressPolicy.
 */
export interface WorkspaceSpecConfig {
	resources?: WorkspaceResourcesConfig
	dependencies?: string[]
	egressPolicy?: EgressPolicyConfig
}

export interface WorkspaceCredentials {
	connectToken: string
	expiresAt: string
	wsUrl: string
	host: string
}

export interface AuthenticateOptions {
	/**
	 * Override the cloud API endpoint (used by tests). Resolution order:
	 * 1. this option
	 * 2. `KIMCHI_REMOTE_ENDPOINT` env-var (for dev / mock-server testing)
	 * 3. production default `https://app.kimchi.dev/api`
	 */
	endpoint?: string
	/**
	 * Override global fetch (used by tests).
	 */
	fetch?: typeof globalThis.fetch
	/**
	 * Git personal access token to forward to the workspace so it
	 * can push/pull on behalf of the user.
	 */
	gitToken?: string
	/**
	 * Create-time workspace spec (resources, dependencies, egress policy)
	 * sent nested under `spec` on workspace-create PUTs. All three sections
	 * are create-time-only server-side: resources are immutable (a re-PUT
	 * with changed values 400s), dependencies and egressPolicy are silently
	 * ignored on upsert — only pass when minting a new workspace, never on
	 * re-auth of an existing one.
	 */
	spec?: WorkspaceSpecConfig
}

export interface ListWorkspacesOptions extends AuthenticateOptions {
	signal?: AbortSignal
	/** Pre-resolved organization id — skips the verifyKey round-trip. */
	orgId?: string
}

export interface GetQuotaUsageOptions extends AuthenticateOptions {
	signal?: AbortSignal
	/** Pre-resolved organization id — skips the verifyKey round-trip. */
	orgId?: string
}

export interface WaitForWorkspaceReadyOptions {
	connectToken: string
	wsUrl: string
	signal?: AbortSignal
	timeoutMs?: number
	pollIntervalMs?: number
	probeTimeoutMs?: number
	wsPath?: string
	onTick?: (info: { elapsedMs: number; lastError?: string }) => void
	// biome-ignore lint/suspicious/noExplicitAny: tests inject a fake WebSocket constructor
	_WebSocket?: any
}

export class RemoteAuthError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
	) {
		super(message)
		this.name = "RemoteAuthError"
	}
}

export class RemoteNetworkError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "RemoteNetworkError"
	}
}

/**
 * Thrown when the cloud API rejects a request because the user's resource
 * quota is exhausted (HTTP 429 with a quota body, e.g. "user CPU limit
 * exceeded"). Carries an already user-facing message — surfaced verbatim
 * instead of being wrapped in "Authentication failed: ...".
 */
export class RemoteQuotaError extends RemoteNetworkError {
	constructor(
		message: string,
		public readonly statusCode: number,
	) {
		super(message)
		this.name = "RemoteQuotaError"
	}
}
