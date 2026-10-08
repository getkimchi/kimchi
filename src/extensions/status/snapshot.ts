// Session status snapshot — the single structured gatherer behind both the
// TUI Status panel (buildStatusRows in index.ts formats it) and the
// `_kimchi.dev/session_status` ACP extension method (ADR
// docs/adr/0001-session-status-acp-ext-method.md). The snapshot keeps
// machine-readable values (login method enum, structured model/MCP fields);
// display strings live in the formatter so Studio can map its own copy and
// the TUI text cannot ossify into the wire contract.

import { existsSync, readFileSync } from "node:fs"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { McpStatusSnapshot } from "pi-mcp-adapter"
import type { Organization } from "../../api/organizations.js"
import { type ApiKeySource, getApiKeySource, getEnvironmentApiKey, getSavedApiKey } from "../../config.js"
import { isKimchiProvider } from "../../kimchi-provider.js"
import { getVersion } from "../../utils.js"
import { isAutoRoutedModel } from "../auto-model/constants.js"
import { resolveEffectiveModel } from "../auto-model/state.js"
import { getKimchiAuthPath } from "../login/flow.js"

/** Machine-readable login methods. Display strings are produced by the TUI formatter. */
export type LoginMethod = "kimchi_account" | "api_key_env" | "api_key_env_override" | "third_party" | "none"

/**
 * Wire contract of `_kimchi.dev/session_status` (camelCase; optional fields
 * absent when unknown): version, login, organization, email, session, model,
 * and MCP counts for one session.
 */
export type StatusSnapshot = {
	version: string
	login: {
		method: LoginMethod
		/** Present when method === "third_party". */
		thirdPartyProviders?: string[]
	}
	organization?: { id: string; name: string }
	email?: string
	session: { name?: string; id: string; cwd: string }
	model: { provider: string; id: string; isAuto: boolean; resolvedModelId?: string } | null
	mcp?: { connected: number; disabled: number; failed: number }
}

/** Connected = tools available; cached counts as usable. */
const MCP_CONNECTED_STATUSES = new Set(["connected", "cached"])
const MCP_DISABLED_STATUS = "disabled"
/**
 * The failed bucket: "failed" and "needs-auth" are the two error states;
 * "not-connected" is a server that is present but unusable, so it counts here
 * too rather than disappearing from the summary.
 */
const MCP_FAILED_STATUSES = new Set(["failed", "needs-auth", "not-connected"])

/** Summary counts for the MCP field of the snapshot. */
export interface McpCounts {
	connected: number
	disabled: number
	failed: number
}

/**
 * Count statuses into the connected/disabled/failed buckets. The status union
 * is closed (see McpServerRuntimeStatus), so connected+disabled+failed always
 * sum to the server total.
 */
export function summarizeMcpSnapshot(snapshot: McpStatusSnapshot): McpCounts {
	let connected = 0
	let disabled = 0
	let failed = 0
	for (const server of snapshot.servers) {
		if (server.status === MCP_DISABLED_STATUS || server.disabled) disabled++
		else if (MCP_CONNECTED_STATUSES.has(server.status)) connected++
		else if (MCP_FAILED_STATUSES.has(server.status)) failed++
	}
	return { connected, disabled, failed }
}

/** Third-party providers from pi's auth.json — kimchi providers excluded. */
function thirdPartyProviders(authPath: string): string[] {
	if (!existsSync(authPath)) return []
	try {
		const creds = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>
		return Object.keys(creds).filter((provider) => !isKimchiProvider(provider))
	} catch {
		return []
	}
}

/**
 * Browser login and the pasted-key flow both persist the same platform key in
 * config.json, so "kimchi_account" is indistinguishable from a saved key; only
 * an env-only key is recognisably an API-key session.
 *
 * configApiKey must be the key persisted in config files only (see
 * getSavedApiKey) — not loadConfig().apiKey, which already has the env
 * override merged in and would make every env session look like
 * "kimchi_account". A differing KIMCHI_API_KEY overrides the saved key for
 * actual requests (see getApiKeyMismatchWarning in config.ts), so it is
 * surfaced first.
 *
 * Precedence: api_key_env_override (KIMCHI_API_KEY set and differs from saved
 * key) → kimchi_account (config key present) →
 * api_key_env (KIMCHI_API_KEY environment, only when no config key) →
 * third_party → none.
 */
export function resolveLoginMethod(deps: {
	envApiKey: string | undefined
	configApiKey: string | undefined
	apiKeySource: ApiKeySource
	authPath: string
}): StatusSnapshot["login"] {
	if (deps.envApiKey && deps.configApiKey && deps.envApiKey !== deps.configApiKey)
		return { method: "api_key_env_override" }
	if (deps.configApiKey) return { method: "kimchi_account" }
	if (deps.apiKeySource === "environment" && deps.envApiKey) return { method: "api_key_env" }
	const others = thirdPartyProviders(deps.authPath)
	if (others.length > 0) return { method: "third_party", thirdPartyProviders: others }
	return { method: "none" }
}

/** Account identity fetched in the background for the key currently in use. */
export interface Identity {
	apiKey: string
	email?: string
	organization?: Organization
}

/** Data the extension collects between snapshot builds. */
export interface StatusSources {
	identity?: Pick<Identity, "email" | "organization">
	mcp?: McpStatusSnapshot
}

/**
 * Re-reads live state per call: login/credential state from
 * config.json/auth.json, session name/id/cwd and model from the live session
 * manager. `identity`/`organization` come from the extension's background
 * fetch (absent until it lands); `mcp` comes from the last pi-mcp-adapter
 * status snapshot event (absent when no snapshot was seen).
 */
export function buildStatusSnapshot(ctx: ExtensionContext, sources: StatusSources = {}): StatusSnapshot {
	const model = ctx.model
	// Auto is a virtual model: the backend stamps the concrete pick per response
	// (tracked in auto-model/state.ts). Surface the last resolved pick; the
	// field stays absent until one lands.
	const effective = isAutoRoutedModel(model)
		? resolveEffectiveModel(model, ctx.sessionManager.getSessionId())
		: undefined
	const resolvedModelId = effective && model && effective.id !== model.id ? effective.id : undefined

	const snapshot: StatusSnapshot = {
		version: getVersion(),
		login: resolveLoginMethod({
			envApiKey: getEnvironmentApiKey(),
			configApiKey: getSavedApiKey(),
			apiKeySource: getApiKeySource(),
			authPath: getKimchiAuthPath(),
		}),
		session: {
			id: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
		},
		model: model
			? {
					provider: model.provider,
					id: model.id,
					isAuto: isAutoRoutedModel(model),
					...(resolvedModelId ? { resolvedModelId } : {}),
				}
			: null,
	}
	if (sources.identity?.organization) {
		snapshot.organization = { id: sources.identity.organization.id, name: sources.identity.organization.name }
	}
	if (sources.identity?.email) snapshot.email = sources.identity.email
	const sessionName = ctx.sessionManager.getSessionName()
	if (sessionName) snapshot.session.name = sessionName
	if (sources.mcp) snapshot.mcp = summarizeMcpSnapshot(sources.mcp)
	return snapshot
}
