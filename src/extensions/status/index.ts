import { existsSync, readFileSync } from "node:fs"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { MCP_STATUS_EVENT, type McpStatusSnapshot } from "pi-mcp-adapter"
import { getMe } from "../../api/me.js"
import { getOrganization, type Organization, verifyApiKey } from "../../api/organizations.js"
import { type ApiKeySource, getApiKeySource, getEnvironmentApiKey, loadConfig } from "../../config.js"
import { isKimchiProvider } from "../../kimchi-provider.js"
import { getVersion } from "../../utils.js"
import { isAutoRoutedModel } from "../auto-model/constants.js"
import { resolveEffectiveModel } from "../auto-model/state.js"
import { getKimchiAuthPath } from "../login/flow.js"
import { createStatusPanelComponent } from "./panel.js"

export const STATUS_COMMAND_DESCRIPTION = "Show version, login, session, model, and MCP status"

/** Connected = tools available; cached counts as usable. */
const MCP_CONNECTED_STATUSES = new Set(["connected", "cached"])
const MCP_DISABLED_STATUS = "disabled"
/**
 * The failed bucket: "failed" and "needs-auth" are the two error states;
 * "not-connected" is a server that is present but unusable, so it counts here
 * too rather than disappearing from the summary.
 */
const MCP_FAILED_STATUSES = new Set(["failed", "needs-auth", "not-connected"])

/** Summary counts for the MCP row of the Status panel. */
export interface McpCounts {
	connected: number
	disabled: number
	failed: number
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
		sessionRows.push(
			row(
				"MCP servers:",
				`${deps.mcp.connected} connected, ${deps.mcp.disabled} disabled, ${deps.mcp.failed} failed · /mcp`,
			),
		)
	} else {
		sessionRows.push(row("MCP servers:", "unavailable · /mcp"))
	}
	return [...identityRows, "", ...sessionRows]
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
 * config.json, so "Kimchi account" is indistinguishable from a saved key; only
 * an env-only key is recognisably an API-key session.
 *
 * Precedence: Kimchi account (config key present) →
 * Kimchi API key (KIMCHI_API_KEY environment, only when no config key) →
 * third-party provider → not logged in.
 */
export function resolveLoginMethod(deps: {
	envApiKey: string | undefined
	configApiKey: string | undefined
	apiKeySource: ApiKeySource
	authPath: string
}): string {
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
	mcp?: McpStatusSnapshot
}

function isMcpStatusSnapshot(data: unknown): data is McpStatusSnapshot {
	return typeof data === "object" && data !== null && Array.isArray((data as { servers?: unknown }).servers)
}

export function gatherStatusRows(ctx: ExtensionContext, sources: StatusSources = {}): string[] {
	const envApiKey = getEnvironmentApiKey()
	const config = loadConfig()

	const model = ctx.model
	const modelRef = model ? `${model.provider}/${model.id}` : "(no model selected)"
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
			configApiKey: config.apiKey,
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
		mcp: sources.mcp ? summarizeMcpSnapshot(sources.mcp) : undefined,
	})
}

export default function statusExtension(pi: ExtensionAPI): void {
	// Per-instance state: pi rebinds extensions on /new, /resume, fork and
	// /reload, so each session starts from a clean slate.
	let identity: Identity | undefined
	let mcpSnapshot: McpStatusSnapshot | undefined

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
	pi.events.on(MCP_STATUS_EVENT, (data) => {
		if (isMcpStatusSnapshot(data)) mcpSnapshot = data
	})
	pi.registerCommand("status", {
		description: STATUS_COMMAND_DESCRIPTION,
		handler: async (_args, ctx) => {
			// Print and JSON modes have no UI surface; notify would be a no-op.
			if (!ctx.hasUI) return
			// Pick up a key that changed mid-session; rows land on the next open.
			refreshIdentity()
			const rows = gatherStatusRows(ctx, { identity, mcp: mcpSnapshot })
			if (ctx.mode === "tui") {
				await ctx.ui.custom<void>((_tui, theme, _kb, done) => createStatusPanelComponent(theme, rows, done))
				return
			}
			ctx.ui.notify(rows.join("\n"), "info")
		},
	})
}
