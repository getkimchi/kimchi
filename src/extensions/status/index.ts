import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { MCP_STATUS_EVENT, type McpStatusSnapshot } from "pi-mcp-adapter"
import { getMe } from "../../api/me.js"
import { getOrganization, verifyApiKey } from "../../api/organizations.js"
import { getEnvironmentApiKey, loadConfig } from "../../config.js"
import { registerStatusProvider, unregisterStatusProvider } from "../../modes/acp/status-provider-registry.js"
import { createStatusPanelComponent } from "./panel.js"
import { buildStatusSnapshot, type Identity, type StatusSnapshot } from "./snapshot.js"

export const STATUS_COMMAND_DESCRIPTION = "Show version, login, session, model, and MCP status"

/** Column width for the `Label:` value gutter. */
const LABEL_WIDTH = 16

/** TUI display strings for the machine-readable login method enum. */
function loginMethodDisplay(login: StatusSnapshot["login"]): string {
	switch (login.method) {
		case "kimchi_account":
			return "Kimchi account"
		case "api_key_env":
			return "Kimchi API key (KIMCHI_API_KEY environment)"
		case "api_key_env_override":
			return "Kimchi API key (KIMCHI_API_KEY environment, overrides saved key)"
		case "third_party":
			return `Third-party provider (${(login.thirdPartyProviders ?? []).join(", ")})`
		case "none":
			return "Not logged in"
	}
}

/**
 * Pure formatter of the session status snapshot. Two blocks separated by a
 * blank row: identity (version, login, org, email) then session (name, id,
 * cwd, model, MCP). Labels are padded to a fixed gutter; the MCP row points
 * at `/mcp` for details.
 */
export function buildStatusRows(snapshot: StatusSnapshot): string[] {
	const row = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}${value}`

	const identityRows = [row("Version:", snapshot.version), row("Login method:", loginMethodDisplay(snapshot.login))]
	if (snapshot.organization) {
		identityRows.push(row("Organization:", `${snapshot.organization.name} (${snapshot.organization.id})`))
	}
	if (snapshot.email) identityRows.push(row("Email:", snapshot.email))

	const modelValue = snapshot.model
		? `${snapshot.model.provider}/${snapshot.model.id}${snapshot.model.isAuto ? ` (${snapshot.model.resolvedModelId ?? "auto"})` : ""}`
		: "(no model selected)"
	const sessionRows = [
		row("Session name:", snapshot.session.name ?? "(unnamed — use /name to add a name)"),
		row("Session ID:", snapshot.session.id),
		row("cwd:", snapshot.session.cwd),
		row("Model:", modelValue),
	]
	if (snapshot.mcp) {
		sessionRows.push(
			row(
				"MCP servers:",
				`${snapshot.mcp.connected} connected, ${snapshot.mcp.disabled} disabled, ${snapshot.mcp.failed} failed · /mcp`,
			),
		)
	} else {
		sessionRows.push(row("MCP servers:", "unavailable · /mcp"))
	}
	return [...identityRows, "", ...sessionRows]
}

function isMcpStatusSnapshot(data: unknown): data is McpStatusSnapshot {
	return typeof data === "object" && data !== null && Array.isArray((data as { servers?: unknown }).servers)
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

	pi.on("session_start", (_event, ctx) => {
		refreshIdentity()
		// Expose this session's snapshot to the session-external ACP ext-method
		// dispatch. Gathering stays here (one place) while
		// `_kimchi.dev/session_status` reaches it through the registry.
		registerStatusProvider(ctx.sessionManager.getSessionId(), () => {
			// refreshIdentity picks up a key changed mid-session, same as the
			// /status handler below; fields land on the next fetch.
			refreshIdentity()
			return buildStatusSnapshot(ctx, { identity, mcp: mcpSnapshot })
		})
	})
	pi.on("session_shutdown", (_event, ctx) => {
		unregisterStatusProvider(ctx.sessionManager.getSessionId())
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
			const rows = buildStatusRows(buildStatusSnapshot(ctx, { identity, mcp: mcpSnapshot }))
			if (ctx.mode === "tui") {
				await ctx.ui.custom<void>((_tui, theme, _kb, done) => createStatusPanelComponent(theme, rows, done))
				return
			}
			ctx.ui.notify(rows.join("\n"), "info")
		},
	})
}
