import { existsSync, readFileSync } from "node:fs"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { MCP_STATUS_EVENT, type McpStatusSnapshot } from "pi-mcp-adapter"
import { getMe } from "../../api/me.js"
import { getEnvironmentApiKey, loadConfig } from "../../config.js"
import { isKimchiProvider } from "../../kimchi-provider.js"
import { getVersion } from "../../utils.js"
import { isAutoRoutedModel } from "../auto-model/constants.js"
import { getKimchiAuthPath } from "../login/flow.js"
import { createStatusPanelComponent } from "./panel.js"

export const STATUS_COMMAND_DESCRIPTION = "Show version, login, session, model, and MCP status"

/** Connected = tools available; cached counts as usable. */
const MCP_CONNECTED_STATUSES = new Set(["connected", "cached"])
const MCP_DISABLED_STATUS = "disabled"

interface StatusRowsDeps {
	version: string
	loginMethod: string
	email: string | undefined
	sessionName: string | undefined
	sessionId: string | undefined
	cwd: string
	modelRef: string
	isAuto: boolean
	mcp: { connected: number; disabled: number; failed: number } | undefined
}

/**
 * Layout from the Status panel decision (see CONTEXT.md "Status panel"):
 * version → login → session, Claude-Code-style alignment, `· /mcp` link.
 */
export function buildStatusRows(deps: StatusRowsDeps): string[] {
	const firstBlock = [`${"Version:".padEnd(16)}${deps.version}`, `${"Login method:".padEnd(16)}${deps.loginMethod}`]
	if (deps.email) firstBlock.push(`${"Email:".padEnd(16)}${deps.email}`)

	const secondBlock = [
		`${"Session name:".padEnd(16)}${deps.sessionName ?? "(unnamed — use /name to add a name)"}`,
		`${"Session ID:".padEnd(16)}${deps.sessionId ?? "unknown"}`,
		`${"cwd:".padEnd(16)}${deps.cwd}`,
		`${"Model:".padEnd(16)}${deps.modelRef}${deps.isAuto ? " (auto)" : ""}`,
	]
	if (deps.mcp) {
		secondBlock.push(
			`${"MCP servers:".padEnd(16)}${deps.mcp.connected} connected, ${deps.mcp.disabled} disabled, ${deps.mcp.failed} failed · /mcp`,
		)
	} else {
		secondBlock.push(`${"MCP servers:".padEnd(16)}unavailable · /mcp`)
	}
	return [...firstBlock, "", ...secondBlock]
}

/** Count statuses ourselves so connected+disabled+failed always sum to the server total. */
export function summarizeMcpSnapshot(snapshot: McpStatusSnapshot): {
	connected: number
	disabled: number
	failed: number
} {
	let connected = 0
	let disabled = 0
	for (const server of snapshot.servers) {
		if (server.status === MCP_DISABLED_STATUS || server.disabled) disabled++
		else if (MCP_CONNECTED_STATUSES.has(server.status)) connected++
	}
	return { connected, disabled, failed: snapshot.servers.length - connected - disabled }
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
 * the environment override is recognisably an API-key session.
 */
export function resolveLoginMethod(deps: {
	envApiKey: string | undefined
	configApiKey: string | undefined
	authPath: string
}): string {
	if (deps.envApiKey) return "Kimchi API key (KIMCHI_API_KEY environment)"
	if (deps.configApiKey) return "Kimchi account"
	const others = thirdPartyProviders(deps.authPath)
	if (others.length > 0) return `Third-party provider (${others.join(", ")})`
	return "Not logged in"
}

// --- cached account email, warmed on session_start (never blocks the panel) ---

let cachedEmail: string | undefined
let emailFetchStarted = false

async function warmEmailCache(): Promise<void> {
	if (emailFetchStarted) return
	emailFetchStarted = true
	const apiKey = getEnvironmentApiKey() ?? loadConfig().apiKey
	if (!apiKey) return
	try {
		const me = await getMe(apiKey)
		cachedEmail = me.email
	} catch {
		// best effort — the panel simply omits the row
	}
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
			authPath: getKimchiAuthPath(),
		}),
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
		void warmEmailCache()
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
