import { existsSync, readFileSync } from "node:fs"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { MCP_STATUS_EVENT, type McpStatusSnapshot } from "pi-mcp-adapter"
import { getMe } from "../../api/me.js"
import { getOrganization, verifyApiKey } from "../../api/organizations.js"
import { getApiKeySource, getEnvironmentApiKey, loadConfig } from "../../config.js"
import { isKimchiProvider } from "../../kimchi-provider.js"
import { getVersion } from "../../utils.js"
import { isAutoRoutedModel } from "../auto-model/constants.js"
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
	organization: { id: string; name: string } | undefined
	email: string | undefined
	sessionName: string | undefined
	sessionId: string | undefined
	cwd: string
	modelRef: string
	isAuto: boolean
	mcp: McpCounts | undefined
}

/** Column width for the Claude-Code-style `Label:` gutter. */
const LABEL_WIDTH = 16

/**
 * Layout from the Status panel decision (see CONTEXT.md "Status panel"):
 * version → login → session, Claude-Code-style alignment, `· /mcp` link.
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
		row("Model:", `${deps.modelRef}${deps.isAuto ? " (auto)" : ""}`),
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
 * Count statuses into the three buckets from the layout mock. The status union
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
 * Precedence (spec Chunk 1): Kimchi account (config key present) →
 * Kimchi API key (KIMCHI_API_KEY environment, only when no config key) →
 * third-party provider → not logged in.
 */
export function resolveLoginMethod(deps: {
	envApiKey: string | undefined
	configApiKey: string | undefined
	apiKeySource: ReturnType<typeof getApiKeySource>
	authPath: string
}): string {
	if (deps.configApiKey) return "Kimchi account"
	if (deps.apiKeySource === "environment" && deps.envApiKey) return "Kimchi API key (KIMCHI_API_KEY environment)"
	const others = thirdPartyProviders(deps.authPath)
	if (others.length > 0) return `Third-party provider (${others.join(", ")})`
	return "Not logged in"
}

// --- cached account email, warmed on session_start (never blocks the panel) ---

let cachedEmail: string | undefined
let cachedOrganization: { id: string; name: string } | undefined
let identityFetchStarted = false

async function warmIdentityCache(): Promise<void> {
	if (identityFetchStarted) return
	identityFetchStarted = true
	const apiKey = getEnvironmentApiKey() ?? loadConfig().apiKey
	if (!apiKey) return
	// Best effort — the panel simply omits rows whose fetch failed.
	void getMe(apiKey)
		.then((me) => {
			cachedEmail = me.email
		})
		.catch(() => {})
	void (async () => {
		try {
			const { organizationId } = await verifyApiKey(apiKey)
			cachedOrganization = await getOrganization(apiKey, organizationId)
		} catch {}
	})()
}

let cachedMcpSnapshot: McpStatusSnapshot | undefined

export async function gatherStatusRows(ctx: ExtensionContext): Promise<string[]> {
	const envApiKey = getEnvironmentApiKey()
	const config = loadConfig()

	const model = ctx.model
	const modelRef = model ? `${model.provider}/${model.id}` : "(no model selected)"

	return buildStatusRows({
		version: getVersion(),
		loginMethod: resolveLoginMethod({
			envApiKey,
			configApiKey: config.apiKey,
			apiKeySource: getApiKeySource(),
			authPath: getKimchiAuthPath(),
		}),
		organization: cachedOrganization,
		email: cachedEmail,
		sessionName: ctx.sessionManager.getSessionName(),
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		modelRef,
		isAuto: isAutoRoutedModel(model),
		mcp: cachedMcpSnapshot ? summarizeMcpSnapshot(cachedMcpSnapshot) : undefined,
	})
}

export default function statusExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		void warmIdentityCache()
	})
	pi.events.on(MCP_STATUS_EVENT, (snapshot: unknown) => {
		cachedMcpSnapshot = snapshot as McpStatusSnapshot
	})
	pi.registerCommand("status", {
		description: STATUS_COMMAND_DESCRIPTION,
		handler: async (_args, ctx) => {
			const rows = await gatherStatusRows(ctx)
			if (ctx.mode === "tui") {
				await ctx.ui.custom<void>((_tui, theme, _kb, done) => createStatusPanelComponent(theme, rows, done))
				return
			}
			ctx.ui.notify(rows.join("\n"), "info")
		},
	})
}
