import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent"
import { getMe } from "../../api/me.js"
import { getOrganization, type Organization, verifyApiKey } from "../../api/organizations.js"
import { type ApiKeySource, getApiKeySource, getEnvironmentApiKey, getSavedApiKey, loadConfig } from "../../config.js"
import { isKimchiProvider } from "../../kimchi-provider.js"
import { getVersion } from "../../utils.js"
import { isAutoRoutedModel } from "../auto-model/constants.js"
import { resolveEffectiveModel } from "../auto-model/state.js"
import { getKimchiAuthPath } from "../login/flow.js"
import { refFromModel } from "../model-catalog/ref-utils.js"
import { createStatusPanelComponent } from "./panel.js"

export const STATUS_COMMAND_DESCRIPTION = "Show version, login, session, model, and MCP status"

/** Connected = tools available; cached counts as usable. */
/**
 * The failed bucket: "failed" and "needs-auth" are the two error states;
 * "not-connected" is a server that is present but unusable, so it counts here
 * too rather than disappearing from the summary.
 */

/** Summary counts for the MCP row of the Status panel. */
export interface McpCounts {
	configured: number
	disabled: number
}

interface StatusRowsDeps {
	version: string
	loginMethod: string
	organization: Organization | undefined
	email: string | undefined
	sessionName: string | undefined
	sessionId: string | undefined
	cwd: string
	modelRef: string
	isAuto: boolean
	/** Concrete model id the Auto router last resolved for this session, if any. */
	resolvedModelId?: string
	mcp: McpCounts | undefined
}

/** Column width for the `Label:` value gutter. */
const LABEL_WIDTH = 16

/**
 * Two blocks separated by a blank row: identity (version, login, org, email)
 * then session (name, id, cwd, model, MCP). Labels are padded to a fixed
 * gutter; the MCP row points at `/mcp` for details.
 */
export function buildStatusRows(deps: StatusRowsDeps): string[] {
	const row = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}${value}`

	const identityRows = [row("Version:", deps.version), row("Login method:", deps.loginMethod)]
	if (deps.organization) {
		identityRows.push(row("Organization:", `${deps.organization.name} (${deps.organization.id})`))
	}
	if (deps.email) identityRows.push(row("Email:", deps.email))

	const sessionRows = [
		row("Session name:", deps.sessionName ?? "(unnamed — use /name to add a name)"),
		row("Session ID:", deps.sessionId ?? "unknown"),
		row("cwd:", deps.cwd),
		row("Model:", `${deps.modelRef}${deps.isAuto ? ` (${deps.resolvedModelId ?? "auto"})` : ""}`),
	]
	if (deps.mcp) {
		sessionRows.push(row("MCP servers:", `${deps.mcp.configured} configured, ${deps.mcp.disabled} disabled · /mcp`))
	} else {
		sessionRows.push(row("MCP servers:", "unavailable · /mcp"))
	}
	return [...identityRows, "", ...sessionRows]
}

/**
 * Config-level MCP summary (native engine — no live snapshot event exists).
 * Connected/failed live states are visible in `/mcp`; this row reports the
 * configured totals from the two native config layers.
 */
export function summarizeMcpConfig(cwd: string): McpCounts {
	const servers = aggregateMcpServers(cwd)
	let disabled = 0
	for (const entry of Object.values(servers)) {
		if (entry.enabled === false || entry.disabled === true) disabled++
	}
	return { configured: Object.keys(servers).length, disabled }
}

function aggregateMcpServers(cwd: string): Record<string, Record<string, unknown>> {
	const merged: Record<string, Record<string, unknown>> = {}
	for (const path of [join(getAgentDir(), "mcp.json"), join(cwd, ".kimchi", "mcp.json")]) {
		if (!existsSync(path)) continue
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> }
			for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
				if (typeof entry === "object" && entry !== null) merged[name] = entry as Record<string, unknown>
			}
		} catch {
			// Unreadable layer: pi reports the config error itself.
		}
	}
	return merged
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
 * config.json, so "Kimchi account" is indistinguishable from a saved key; only
 * an env-only key is recognisably an API-key session.
 *
 * configApiKey must be the key persisted in config files only (see
 * getSavedApiKey) — not loadConfig().apiKey, which already has the env
 * override merged in and would make every env session look like "Kimchi
 * account". A differing KIMCHI_API_KEY overrides the saved key for actual
 * requests (see getApiKeyMismatchWarning in config.ts), so it is surfaced first.
 *
 * Precedence: env override (KIMCHI_API_KEY set and differs from saved key) →
 * Kimchi account (config key present) →
 * Kimchi API key (KIMCHI_API_KEY environment, only when no config key) →
 * third-party provider → not logged in.
 */
export function resolveLoginMethod(deps: {
	envApiKey: string | undefined
	configApiKey: string | undefined
	apiKeySource: ApiKeySource
	authPath: string
}): string {
	if (deps.envApiKey && deps.configApiKey && deps.envApiKey !== deps.configApiKey)
		return "Kimchi API key (KIMCHI_API_KEY environment, overrides saved key)"
	if (deps.configApiKey) return "Kimchi account"
	if (deps.apiKeySource === "environment" && deps.envApiKey) return "Kimchi API key (KIMCHI_API_KEY environment)"
	const others = thirdPartyProviders(deps.authPath)
	if (others.length > 0) return `Third-party provider (${others.join(", ")})`
	return "Not logged in"
}

/** Account identity fetched in the background for the key currently in use. */
interface Identity {
	apiKey: string
	email?: string
	organization?: Organization
}

/** Data the extension collects between `/status` invocations. */
export interface StatusSources {
	identity?: Pick<Identity, "email" | "organization">
	mcp?: McpCounts
}

export function gatherStatusRows(ctx: ExtensionContext, sources: StatusSources = {}): string[] {
	const envApiKey = getEnvironmentApiKey()

	const model = ctx.model
	const modelRef = model ? refFromModel(model) : "(no model selected)"
	// Auto is a virtual model: the backend stamps the concrete pick per response
	// (tracked in auto-model/state.ts). Surface the last resolved pick; the row
	// falls back to "(auto)" until one lands.
	const effective = isAutoRoutedModel(model)
		? resolveEffectiveModel(model, ctx.sessionManager.getSessionId())
		: undefined
	const resolvedModelId = effective && model && effective.id !== model.id ? effective.id : undefined

	return buildStatusRows({
		version: getVersion(),
		loginMethod: resolveLoginMethod({
			envApiKey,
			configApiKey: getSavedApiKey(),
			apiKeySource: getApiKeySource(),
			authPath: getKimchiAuthPath(),
		}),
		organization: sources.identity?.organization,
		email: sources.identity?.email,
		sessionName: ctx.sessionManager.getSessionName(),
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		modelRef,
		isAuto: isAutoRoutedModel(model),
		resolvedModelId,
		mcp: sources.mcp,
	})
}

export default function statusExtension(pi: ExtensionAPI): void {
	// Per-instance state: pi rebinds extensions on /new, /resume, fork and
	// /reload, so each session starts from a clean slate.
	let identity: Identity | undefined

	/**
	 * Best-effort background fetch of email and organization for the active
	 * key; never blocks the panel, which omits rows whose fetch has not landed.
	 * Refetches only when the key changes (e.g. after /login or /logout).
	 */
	const refreshIdentity = (): void => {
		const apiKey = getEnvironmentApiKey() ?? loadConfig().apiKey
		if (!apiKey) {
			identity = undefined
			return
		}
		if (identity?.apiKey === apiKey) return
		// Writes go to this object, so a fetch for a superseded key cannot
		// overwrite the identity of the current one.
		const current: Identity = { apiKey }
		identity = current
		getMe(apiKey)
			.then((me) => {
				current.email = me.email
			})
			.catch(() => {})
		verifyApiKey(apiKey)
			.then(({ organizationId }) => getOrganization(apiKey, organizationId))
			.then((organization) => {
				current.organization = organization
			})
			.catch(() => {})
	}

	pi.on("session_start", () => {
		refreshIdentity()
	})
	pi.registerCommand("status", {
		description: STATUS_COMMAND_DESCRIPTION,
		handler: async (_args, ctx) => {
			// Print and JSON modes have no UI surface; notify would be a no-op.
			if (!ctx.hasUI) return
			// Pick up a key that changed mid-session; rows land on the next open.
			refreshIdentity()
			const rows = gatherStatusRows(ctx, { identity, mcp: summarizeMcpConfig(ctx.cwd) })
			if (ctx.mode === "tui") {
				await ctx.ui.custom<void>((_tui, theme, _kb, done) => createStatusPanelComponent(theme, rows, done))
				return
			}
			ctx.ui.notify(rows.join("\n"), "info")
		},
	})
}
