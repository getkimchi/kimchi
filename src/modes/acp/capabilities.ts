import type { ClientCapabilities } from "@agentclientprotocol/sdk"

export const CAPABILITIES_KEY = "kimchi.dev"

// Wire method names for kimchi.dev extension methods. The key is the local
// identifier; the value is the method string sent over extMethod /
// extNotification. Entries are grouped by direction and scope:
//
// - agent→client: pi_* methods (the agent calls conn.extMethod on the client).
// - session-scoped inbound: require a live session, routed by sessionId
//   (the agent's extMethod() handler receives them).
// - sessionless inbound: no session involved (auth, onboarding, import,
//   trust reads/decisions that operate on paths or project state, resource
//   and memory store ops).
// - misc inbound: probe_mcp_server (SDK-era probing helper).
//
// project_trust_update is an agent→client extNotification (pushed after
//   session creation and whenever a trust decision changes), following the
//   queue_dropped precedent: not advertised in _meta (unaware clients ignore
//   unknown ext notifications per JSON-RPC rules), sessionId carried in the
//   payload because ext notifications are not session-scoped on the wire.
//
// routed_model is an agent→client extNotification mirroring the auto-router's
//   routed-pick entry, on the project_trust_update precedent: not advertised
//   in _meta, sessionId carried in the payload.
//
// background_run_start / background_run_end are agent→client extNotifications bracketing an
//   agent-initiated run (one no client prompt owns), on the same precedent:
//   not advertised in _meta, sessionId carried in the payload.
//
// Capability advertising: every entry here is exposed in
// `_meta["kimchi.dev"][<key>] === true` so clients can discover the methods
// the agent supports.
export const AVAILABLE_EXT_METHODS = {
	// Agent→client (outbound). The agent calls conn.extMethod on the client.
	pi_editor: `_${CAPABILITIES_KEY}/pi_editor`,

	// Session-scoped inbound — require a live session, routed by sessionId.
	set_session_title: `_${CAPABILITIES_KEY}/set_session_title`,
	steering: `_${CAPABILITIES_KEY}/steering`,
	feedback: `_${CAPABILITIES_KEY}/feedback`,
	compact: `_${CAPABILITIES_KEY}/compact`,
	compact_abort: `_${CAPABILITIES_KEY}/compact_abort`,
	memory_status: `_${CAPABILITIES_KEY}/memory_status`,
	set_memory_enabled: `_${CAPABILITIES_KEY}/set_memory_enabled`,
	pr_status: `_${CAPABILITIES_KEY}/pr_status`,
	set_pr_monitor: `_${CAPABILITIES_KEY}/set_pr_monitor`,

	// Sessionless inbound — no session involved.
	auth_status: `_${CAPABILITIES_KEY}/auth_status`,
	// Cast AI SSO login: stepwise, sessionless flow driven by the client —
	// begin returns the authorize URL without opening a browser, await waits
	// for the browser leg and settles either directly (single org) or with
	// the org list for an in-app pick (select_org completes it), cancel
	// aborts. Advertised to clients via `_meta["kimchi.dev"].sso`.
	sso_begin: `_${CAPABILITIES_KEY}/sso_begin`,
	sso_await: `_${CAPABILITIES_KEY}/sso_await`,
	sso_select_org: `_${CAPABILITIES_KEY}/sso_select_org`,
	sso_cancel: `_${CAPABILITIES_KEY}/sso_cancel`,
	// Post-SSO credential export (LLM-4134, ticket #643): returns the current
	// valid org-scoped OAuth bearer for the canonical kimchi-dev entry — the
	// same token the harness itself sends as `Authorization: Bearer` (verified
	// accepted by /v1/me and /v1/organizations; X-API-Key is rejected).
	// Refreshed with the harness's lazy-refresh discipline;
	// SSO_NOT_AUTHENTICATED for non-SSO sessions.
	// SECURITY: this hands out a LIVE bearer with no user interaction, unlike
	// the sso_* login flow. Clients must OPT IN by declaring `sso_credential:
	// true` in their initialize `_meta["kimchi.dev"]` capabilities — the agent
	// refuses the method (methodNotFound) otherwise, so a network-exposed ACP
	// transport (socket, port-forward, remote container) is not a
	// credential-harvest endpoint by default. Every export is logged
	// server-side (org + expiry only, never the token). If the ACP server ever
	// gains a non-local transport, this opt-in seam must trip a security
	// review before the method stays servable.
	sso_credential: `_${CAPABILITIES_KEY}/sso_credential`,

	set_onboarding_flag: `_${CAPABILITIES_KEY}/set_onboarding_flag`,
	import_discover: `_${CAPABILITIES_KEY}/import_discover`,
	import_apply: `_${CAPABILITIES_KEY}/import_apply`,
	set_project_trust: `_${CAPABILITIES_KEY}/set_project_trust`,
	get_path_trust: `_${CAPABILITIES_KEY}/get_path_trust`,
	set_path_trust: `_${CAPABILITIES_KEY}/set_path_trust`,

	// Sessionless inbound, resources and memory store ops.
	list_resources: `_${CAPABILITIES_KEY}/list_resources`,
	set_resource_enabled: `_${CAPABILITIES_KEY}/set_resource_enabled`,
	memory_list: `_${CAPABILITIES_KEY}/memory_list`,
	memory_search: `_${CAPABILITIES_KEY}/memory_search`,
	memory_delete: `_${CAPABILITIES_KEY}/memory_delete`,
	memory_reset: `_${CAPABILITIES_KEY}/memory_reset`,

	// Misc inbound — standalone probing helper.
	probe_mcp_server: `_${CAPABILITIES_KEY}/probe_mcp_server`,
} as const

export const AVAILABLE_EXT_NOTIFICATIONS = {
	pr_update: `_${CAPABILITIES_KEY}/pr_update`,
	pi_notify: `_${CAPABILITIES_KEY}/pi_notify`,
	queue_dropped: `_${CAPABILITIES_KEY}/queue_dropped`,
	project_trust_update: `_${CAPABILITIES_KEY}/project_trust_update`,
	agent_activity: `_${CAPABILITIES_KEY}/agent_activity`,
	routed_model: `_${CAPABILITIES_KEY}/routed_model`,
	skill_autoload: `_${CAPABILITIES_KEY}/skill_autoload`,
	background_run_start: `_${CAPABILITIES_KEY}/background_run_start`,
	background_run_end: `_${CAPABILITIES_KEY}/background_run_end`,
} as const

export type AcpExtMethod = keyof typeof AVAILABLE_EXT_METHODS

export const ADVERTISED_CAPABILITIES: Record<AcpExtMethod, boolean> = Object.keys(AVAILABLE_EXT_METHODS).reduce(
	(acc, method) => {
		acc[method as AcpExtMethod] = true
		return acc
	},
	{} as Record<AcpExtMethod, boolean>,
)

export function getClientSupportsMethod(capabilities: ClientCapabilities | undefined, method: AcpExtMethod): boolean {
	const flags = capabilities?._meta?.[CAPABILITIES_KEY] as Record<string, boolean> | undefined
	return flags?.[method] === true
}

/**
 * Client opt-in key for background runs, in
 * `clientCapabilities._meta["kimchi.dev"]` at initialize. Opted-in clients
 * get async background runs: a prompt turn may END while bash commands keep
 * running, the agent wakes itself on process exit (no prompt outstanding),
 * and background_run_start/background_run_end bracket that wake so the client can own the stop
 * button. Clients that do NOT opt in keep the pre-#1616 completion guard:
 * the turn waits out its background commands, so the client's existing stop
 * button covers everything and prompts never park mid-run. The agent
 * advertises the same key in its own capabilities _meta so clients can
 * feature-detect the gate.
 */
export const BACKGROUND_RUNS_CAPABILITY = "backgroundRuns"

/** True when the client opted into background runs at initialize. */
export function getClientOptedIntoBackgroundRuns(capabilities: ClientCapabilities | undefined): boolean {
	const flags = capabilities?._meta?.[CAPABILITIES_KEY] as Record<string, boolean> | undefined
	return flags?.[BACKGROUND_RUNS_CAPABILITY] === true
}

// Kimchi-specific PR controls have no dedicated RFD. Runs reuse the existing
// v1 backgroundRuns bridge to https://agentclientprotocol.com/rfds/v2/background-work.
export const PR_MONITORING_CAPABILITY = "prMonitoring"

export function getClientOptedIntoPRMonitoring(capabilities: ClientCapabilities | undefined): boolean {
	const flags = capabilities?._meta?.[CAPABILITIES_KEY] as Record<string, boolean> | undefined
	return flags?.[PR_MONITORING_CAPABILITY] === true && getClientOptedIntoBackgroundRuns(capabilities)
}

/**
 * A `_meta` payload namespaced under the kimchi.dev capability key — the
 * shape `kimchiDevMetaOf` produces and `_meta` readers consume.
 */
export type KimchiDevMeta<T> = { [CAPABILITIES_KEY]: T }

/**
 * Wrap a payload in the nested `_meta` object namespaced under the kimchi.dev
 * capability key — the shared shape of the initialize capability
 * advertisement and per-chunk model attribution.
 */
export function kimchiDevMetaOf<T>(payload: T): KimchiDevMeta<T> {
	return { [CAPABILITIES_KEY]: payload }
}

// Presence-based on purpose: an empty `form: {}` is the documented way to
// declare elicitation support, so any non-null value is enough.
export function getClientSupportsElicitation(capabilities: ClientCapabilities | undefined): boolean {
	return capabilities?.elicitation?.form != null
}
