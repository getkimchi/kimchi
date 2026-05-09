import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getServerProvenance, writeDirectToolsConfig } from "./config.js"
import { getFailureAgeSeconds, lazyConnect, updateMetadataCache, updateStatusBar } from "./init.js"
import { authenticate, supportsOAuth } from "./mcp-auth-flow.js"
import { hasStoredTokens } from "./mcp-auth.js"
import { loadMetadataCache } from "./metadata-cache.js"
import type { McpExtensionState } from "./state.js"
import { buildToolMetadata } from "./tool-metadata.js"
import type { McpConfig, McpPanelCallbacks, McpPanelResult, ServerEntry } from "./types.js"

export async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return

	const lines: string[] = ["MCP Server Status:", ""]

	for (const name of Object.keys(state.config.mcpServers)) {
		const connection = state.manager.getConnection(name)
		const metadata = state.toolMetadata.get(name)
		const toolCount = metadata?.length ?? 0
		const failedAgo = getFailureAgeSeconds(state, name)
		let status = "not connected"
		let statusIcon = "○"
		let failed = false

		if (connection?.status === "connected") {
			status = "connected"
			statusIcon = "✓"
		} else if (connection?.status === "needs-auth") {
			status = "needs auth"
			statusIcon = "⚠"
		} else if (failedAgo !== null) {
			status = `failed ${failedAgo}s ago`
			statusIcon = "✗"
			failed = true
		} else if (metadata !== undefined) {
			status = "cached"
		}

		const toolSuffix = failed ? "" : ` (${toolCount} tools${status === "cached" ? ", cached" : ""})`
		lines.push(`${statusIcon} ${name}: ${status}${toolSuffix}`)
	}

	if (Object.keys(state.config.mcpServers).length === 0) {
		lines.push("No MCP servers configured")
	}

	ctx.ui.notify(lines.join("\n"), "info")
}

export async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return

	const allTools = [...state.toolMetadata.values()].flat().map((m) => m.name)

	if (allTools.length === 0) {
		ctx.ui.notify("No MCP tools available", "info")
		return
	}

	const lines = ["MCP Tools:", "", ...allTools.map((t) => `  ${t}`), "", `Total: ${allTools.length} tools`]

	ctx.ui.notify(lines.join("\n"), "info")
}

export async function reconnectServers(
	state: McpExtensionState,
	ctx: ExtensionContext,
	targetServer?: string,
): Promise<void> {
	if (targetServer && !state.config.mcpServers[targetServer]) {
		if (ctx.hasUI) {
			ctx.ui.notify(`Server "${targetServer}" not found in config`, "error")
		}
		return
	}

	const entries = targetServer
		? [[targetServer, state.config.mcpServers[targetServer]] as [string, ServerEntry]]
		: Object.entries(state.config.mcpServers)

	for (const [name, definition] of entries) {
		try {
			await state.manager.close(name)

			const connection = await state.manager.connect(name, definition)
			if (connection.status === "needs-auth") {
				if (ctx.hasUI) {
					ctx.ui.notify(`MCP: ${name} requires OAuth. Run /mcp-auth ${name} first.`, "warning")
				}
				continue
			}
			const prefix = state.config.settings?.toolPrefix ?? "server"

			const { metadata, failedTools } = buildToolMetadata(
				connection.tools,
				connection.resources,
				definition,
				name,
				prefix,
			)
			state.toolMetadata.set(name, metadata)
			updateMetadataCache(state, name)
			state.failureTracker.delete(name)

			if (ctx.hasUI) {
				ctx.ui.notify(
					`MCP: Reconnected to ${name} (${connection.tools.length} tools, ${connection.resources.length} resources)`,
					"info",
				)
				if (failedTools.length > 0) {
					ctx.ui.notify(`MCP: ${name} - ${failedTools.length} tools skipped`, "warning")
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			state.failureTracker.set(name, Date.now())
			if (ctx.hasUI) {
				ctx.ui.notify(`MCP: Failed to reconnect to ${name}: ${message}`, "error")
			}
		}
	}

	updateStatusBar(state)
}

export async function authenticateServer(serverName: string, config: McpConfig, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return

	const definition = config.mcpServers[serverName]
	if (!definition) {
		ctx.ui.notify(`Server "${serverName}" not found in config`, "error")
		return
	}

	if (!supportsOAuth(definition)) {
		ctx.ui.notify(
			`Server "${serverName}" does not use OAuth authentication.\n` +
				`Set "auth": "oauth" or omit auth for auto-detection.`,
			"error",
		)
		return
	}

	if (!definition.url) {
		ctx.ui.notify(`Server "${serverName}" has no URL configured (OAuth requires HTTP transport)`, "error")
		return
	}

	// Full automatic OAuth flow using SDK
	try {
		ctx.ui.setStatus("mcp-auth", `Authenticating ${serverName}...`)

		// Runs the configured OAuth flow (interactive browser or non-interactive client_credentials)
		const status = await authenticate(serverName, definition.url, definition)

		if (status === "authenticated") {
			ctx.ui.notify(
				`OAuth authentication successful for "${serverName}"!\n` +
					`Run /mcp reconnect ${serverName} to connect with the new token.`,
				"info",
			)
		} else {
			ctx.ui.notify(`OAuth authentication failed for "${serverName}".`, "error")
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		ctx.ui.notify(`Failed to authenticate "${serverName}": ${message}`, "error")
	} finally {
		ctx.ui.setStatus("mcp-auth", undefined)
	}
}

export async function openMcpPanel(
	state: McpExtensionState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	configOverridePath?: string,
): Promise<void> {
	const config = state.config
	const cache = loadMetadataCache()
	const provenanceMap = getServerProvenance((pi.getFlag("mcp-config") as string | undefined) ?? configOverridePath)

	const callbacks: McpPanelCallbacks = {
		reconnect: async (serverName: string) => {
			return lazyConnect(state, serverName)
		},
		getConnectionStatus: (serverName: string) => {
			const definition = config.mcpServers[serverName]
			const connection = state.manager.getConnection(serverName)
			if (connection?.status === "needs-auth") {
				return "needs-auth"
			}
			if (
				definition?.auth === "oauth" &&
				definition.oauth !== false &&
				definition.oauth?.grantType !== "client_credentials" &&
				!hasStoredTokens(serverName)
			) {
				return "needs-auth"
			}
			if (connection?.status === "connected") return "connected"
			if (getFailureAgeSeconds(state, serverName) !== null) return "failed"
			return "idle"
		},
		refreshCacheAfterReconnect: (serverName: string) => {
			const freshCache = loadMetadataCache()
			return freshCache?.servers?.[serverName] ?? null
		},
	}

	const { createMcpPanel } = await import("./mcp-panel.js")

	return new Promise<void>((resolve) => {
		ctx.ui.custom(
			(tui, _theme, _keybindings, done) => {
				return createMcpPanel(config, cache, provenanceMap, callbacks, tui, (result: McpPanelResult) => {
					if (!result.cancelled && result.changes.size > 0) {
						writeDirectToolsConfig(result.changes, provenanceMap, config)
						ctx.ui.notify("Direct tools updated. Restart pi to apply.", "info")
					}
					done(undefined)
					// Force a clean redraw so any overlay artifacts are cleared from
					// scrollback when the panel closes.
					tui.requestRender(true)
					resolve()
				})
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: 82, maxHeight: "100%" } },
		)
	})
}
