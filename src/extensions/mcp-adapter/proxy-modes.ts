import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import type { AgentToolResult, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { truncateTail } from "@earendil-works/pi-coding-agent"
import type { SearchStrategy } from "./bm25.js"
import {
	getFailureAgeSeconds,
	lazyConnect,
	updateMetadataCache,
	updateServerMetadata,
	updateStatusBar,
} from "./init.js"
import { authenticate, supportsOAuth } from "./mcp-auth-flow.js"
import type { McpExtensionState } from "./state.js"
import { buildToolMetadata, findToolByName, formatSchema, getToolNames } from "./tool-metadata.js"
import { transformMcpContent } from "./tool-registrar.js"
import type { DirectToolSpec, McpContent, ToolMetadata } from "./types.js"
import { getServerPrefix, parseUiPromptHandoff } from "./types.js"
import { type UiSessionRuntime, maybeStartUiSession } from "./ui-session.js"
import { truncateAtWord } from "./utils.js"

type ProxyToolResult = AgentToolResult<Record<string, unknown>>

import type { ImageContent, TextContent } from "@earendil-works/pi-ai"

type ContentBlock = TextContent | ImageContent

function applyTruncation(content: ContentBlock[]): ContentBlock[] {
	const textItems = content.filter((c): c is TextContent => c.type === "text")
	if (textItems.length === 0) return content

	const combined = textItems.map((c) => c.text).join("\n")
	const result = truncateTail(combined)
	if (!result.truncated) return content

	const notice = `\n[Truncated: showing last ${result.outputLines} of ${result.totalLines} lines (${result.totalBytes.toLocaleString()} bytes total). Use mcp({ describe: "tool_name" }) to check parameters if needed.]`
	const nonText = content.filter((c): c is ImageContent => c.type !== "text")
	return [{ type: "text" as const, text: result.content + notice }, ...nonText]
}

function applyOffload(
	content: ContentBlock[],
	toolName: string,
	maxChars: number,
	ctx: ExtensionContext,
): ContentBlock[] {
	const textItems = content.filter((c): c is TextContent => c.type === "text")
	if (textItems.length === 0) return content

	const combined = textItems.map((c) => c.text).join("\n")
	if (combined.length <= maxChars) return content

	const nonText = content.filter((c) => c.type !== "text")

	// Lightweight format detection — avoids JSON.parse on large strings
	const ext = /^\s*[\{\[]/.test(combined) ? "json" : "txt"

	// Derive output directory from session file
	let dir: string
	const sessionFile = ctx.sessionManager.getSessionFile()
	if (sessionFile) {
		dir = join(dirname(sessionFile), "tool-results")
	} else {
		dir = join(tmpdir(), `kimchi-tool-results-${userInfo().uid}`)
	}

	let path: string
	try {
		mkdirSync(dir, { recursive: true })
		path = join(dir, `${randomUUID()}.${ext}`)
		writeFileSync(path, combined, "utf-8")
	} catch (err) {
		console.warn(`[mcp-adapter] applyOffload: failed to write tool result to disk:`, err)
		// Hard-slice fallback — do NOT use truncateTail; it fails on single-line blobs
		const sliced = combined.slice(0, maxChars) + "\n\n... [Truncated due to I/O error]"
		return [...nonText, { type: "text" as const, text: sliced }]
	}

	const format = ext === "json" ? "JSON" : "Plain text"
	const message = `result (${combined.length.toLocaleString()} characters) exceeds limit. Full output saved to ${path}.
Format: ${format}
- To search: use bash with grep on the file directly
- To read in chunks: bash -c "python3 -c \\"print(open('${path}').read()[A:B])\\""
- For analysis requiring full content: use a subagent with the file path`

	return [...nonText, { type: "text" as const, text: message }]
}

type AutoAuthResult = { status: "skipped" } | { status: "success" } | { status: "failed"; message: string }

function getAuthRequiredMessage(serverName: string): string {
	return `Server "${serverName}" requires OAuth authentication. Run /mcp-auth ${serverName} first.`
}

async function attemptAutoAuth(state: McpExtensionState, serverName: string): Promise<AutoAuthResult> {
	if (state.config.settings?.autoAuth !== true) {
		return { status: "skipped" }
	}

	const definition = state.config.mcpServers[serverName]
	if (!definition || !supportsOAuth(definition) || !definition.url) {
		return { status: "skipped" }
	}

	const grantType =
		(definition.oauth && typeof definition.oauth === "object" && definition.oauth.grantType) || "authorization_code"
	if (!state.ui && grantType !== "client_credentials") {
		return {
			status: "failed",
			message: `Server "${serverName}" requires OAuth authentication. Run /mcp-auth ${serverName} in an interactive session.`,
		}
	}

	try {
		await authenticate(serverName, definition.url, definition)
		return { status: "success" }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return {
			status: "failed",
			message: `OAuth authentication failed for "${serverName}": ${message}. Run /mcp-auth ${serverName} first.`,
		}
	}
}

export function executeUiMessages(state: McpExtensionState): ProxyToolResult {
	const sessions = state.completedUiSessions

	if (sessions.length === 0) {
		return {
			content: [{ type: "text" as const, text: "No UI session messages available." }],
			details: { sessions: 0 },
		}
	}

	const output: string[] = []
	output.push(`UI Session Messages (${sessions.length} session${sessions.length > 1 ? "s" : ""}):\n`)

	const allPrompts: string[] = []
	const allIntents = sessions.flatMap((session) => session.messages.intents)
	const parsedHandoffs: Array<{ intent: string; params: Record<string, unknown>; raw: string }> = []

	for (const session of sessions) {
		const timestamp = session.completedAt.toLocaleTimeString()
		output.push(`\n## ${session.serverName} / ${session.toolName} (${timestamp}, ${session.reason})`)

		const plainPrompts: string[] = []
		for (const prompt of session.messages.prompts) {
			allPrompts.push(prompt)
			const handoff = parseUiPromptHandoff(prompt)
			if (handoff) {
				parsedHandoffs.push(handoff)
			} else {
				plainPrompts.push(prompt)
			}
		}

		if (plainPrompts.length > 0) {
			output.push("\n### Prompts:")
			for (const prompt of plainPrompts) {
				output.push(`- ${prompt}`)
			}
		}

		const intentsForSession = [
			...session.messages.intents,
			...session.messages.prompts
				.map((prompt) => parseUiPromptHandoff(prompt))
				.filter((handoff): handoff is NonNullable<typeof handoff> => !!handoff)
				.map((handoff) => ({ intent: handoff.intent, params: handoff.params })),
		]

		if (intentsForSession.length > 0) {
			output.push("\n### Intents:")
			for (const intent of intentsForSession) {
				const params = intent.params ? ` (${JSON.stringify(intent.params)})` : ""
				output.push(`- ${intent.intent}${params}`)
			}
		}

		if (session.messages.notifications.length > 0) {
			output.push("\n### Notifications:")
			for (const notification of session.messages.notifications) {
				output.push(`- ${notification}`)
			}
		}
	}

	const count = sessions.length
	state.completedUiSessions = []

	return {
		content: [{ type: "text" as const, text: output.join("\n") }],
		details: {
			sessions: count,
			prompts: allPrompts,
			intents: [...allIntents, ...parsedHandoffs.map(({ intent, params }) => ({ intent, params }))],
			handoffs: parsedHandoffs,
			cleared: true,
		},
	}
}

export function executeStatus(state: McpExtensionState): ProxyToolResult {
	const servers: Array<{ name: string; status: string; toolCount: number; failedAgo: number | null }> = []

	for (const name of Object.keys(state.config.mcpServers)) {
		const connection = state.manager.getConnection(name)
		const metadata = state.toolMetadata.get(name)
		const toolCount = metadata?.length ?? 0
		const failedAgo = getFailureAgeSeconds(state, name)
		let status = "not connected"
		if (connection?.status === "connected") {
			status = "connected"
		} else if (connection?.status === "needs-auth") {
			status = "needs-auth"
		} else if (failedAgo !== null) {
			status = "failed"
		} else if (metadata !== undefined) {
			status = "cached"
		}

		servers.push({ name, status, toolCount, failedAgo })
	}

	const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0)
	const connectedCount = servers.filter((s) => s.status === "connected").length

	let text = `MCP: ${connectedCount}/${servers.length} servers, ${totalTools} tools\n\n`
	for (const server of servers) {
		if (server.status === "connected") {
			text += `✓ ${server.name} (${server.toolCount} tools)\n`
			continue
		}
		if (server.status === "needs-auth") {
			text += `⚠ ${server.name} (needs auth)\n`
			continue
		}
		if (server.status === "cached") {
			text += `○ ${server.name} (${server.toolCount} tools, cached)\n`
			continue
		}
		if (server.status === "failed") {
			text += `✗ ${server.name} (failed ${server.failedAgo ?? 0}s ago)\n`
			continue
		}
		text += `○ ${server.name} (not connected)\n`
	}

	if (servers.length > 0) {
		text += `\nmcp({ search: "..." }) to find tools, mcp({ describe: "tool_name" }) to get schema`
	}

	return {
		content: [{ type: "text" as const, text: text.trim() }],
		details: { mode: "status", servers, totalTools, connectedCount },
	}
}

export function executeDescribe(
	state: McpExtensionState,
	toolName: string,
	onInject?: (specs: DirectToolSpec[]) => string[],
): ProxyToolResult {
	let serverName: string | undefined
	let toolMeta: ToolMetadata | undefined

	for (const [server, metadata] of state.toolMetadata.entries()) {
		const found = findToolByName(metadata, toolName)
		if (found) {
			serverName = server
			toolMeta = found
			break
		}
	}

	if (!serverName || !toolMeta) {
		return {
			content: [{ type: "text" as const, text: `Tool "${toolName}" not found. Use mcp({ search: "..." }) to search.` }],
			details: { mode: "describe", error: "tool_not_found", requestedTool: toolName },
		}
	}

	let injectedNames: string[] = []
	if (onInject && !toolMeta.resourceUri) {
		injectedNames = onInject([
			{
				serverName,
				originalName: toolMeta.name,
				prefixedName: toolName,
				description: toolMeta.description ?? "",
				inputSchema: toolMeta.inputSchema,
				uiResourceUri: toolMeta.uiResourceUri,
				uiStreamMode: toolMeta.uiStreamMode,
			},
		])
	}

	let text = `${toolMeta.name}\n`
	text += `Server: ${serverName}\n`
	if (toolMeta.resourceUri) {
		text += `Type: Resource (reads from ${toolMeta.resourceUri})\n`
	}
	text += `\n${toolMeta.description || "(no description)"}\n`

	if (toolMeta.inputSchema && !toolMeta.resourceUri) {
		text += `\nParameters:\n${formatSchema(toolMeta.inputSchema)}`
	} else if (toolMeta.resourceUri) {
		text += `\nNo parameters required (resource tool).`
	} else {
		text += `\nNo parameters defined.`
	}

	if (injectedNames.length > 0) {
		text += `\n\nInjected into context. Call it using the exact name shown above (do NOT add any prefix): ${injectedNames[0]}`
	}

	return {
		content: [{ type: "text" as const, text: text.trim() }],
		details: { mode: "describe", tool: toolMeta, server: serverName, injected: injectedNames },
	}
}

export function executeSearch(
	state: McpExtensionState,
	query: string,
	regex?: boolean,
	server?: string,
	includeSchemas?: boolean,
	getPiTools?: () => ToolInfo[],
	limit = 5,
	strategy?: SearchStrategy,
	onInject?: (specs: DirectToolSpec[]) => string[],
): ProxyToolResult {
	const showSchemas = includeSchemas !== false

	// Validate query upfront for both paths
	const trimmed = query.trim()
	if (trimmed.length === 0) {
		return {
			content: [{ type: "text" as const, text: "Search query cannot be empty" }],
			details: { mode: "search", error: "empty_query" },
		}
	}

	// Pi tool search always uses regex (they're not in the MCP index)
	const piMatches: Array<{ name: string; description: string }> = []
	if (!server && getPiTools) {
		let piPattern: RegExp
		try {
			if (regex) {
				piPattern = new RegExp(trimmed, "i")
			} else {
				const escaped = trimmed
					.split(/\s+/)
					.filter((t) => t.length > 0)
					.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				piPattern = new RegExp(escaped.join("|"), "i")
			}
			for (const tool of getPiTools()) {
				if (tool.name === "mcp") continue
				if (piPattern.test(tool.name) || piPattern.test(tool.description ?? "")) {
					piMatches.push({ name: tool.name, description: tool.description ?? "" })
				}
			}
		} catch {
			// invalid regex — skip pi tools
		}
	}

	// MCP tool search: use strategy (BM25/regex) unless regex flag forces legacy path
	const matches: Array<{ server: string; tool: ToolMetadata }> = []

	if (!regex && strategy) {
		// Strategy-based search across all MCP tools, then filter by server if needed
		const results = strategy.search(trimmed, server ? Number.MAX_SAFE_INTEGER : limit)
		for (const result of results) {
			if (server && result.entry.server !== server) continue
			const serverMeta = state.toolMetadata.get(result.entry.server)
			const toolMeta = serverMeta?.find((t) => t.name === result.entry.name)
			if (toolMeta) {
				matches.push({ server: result.entry.server, tool: toolMeta })
			}
		}
	} else {
		// Legacy regex path (when regex=true or no strategy available)
		let pattern: RegExp
		try {
			if (regex) {
				pattern = new RegExp(trimmed, "i")
			} else {
				const escaped = trimmed
					.split(/\s+/)
					.filter((t) => t.length > 0)
					.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				pattern = new RegExp(escaped.join("|"), "i")
			}
		} catch {
			return {
				content: [{ type: "text" as const, text: `Invalid regex: ${query}` }],
				details: { mode: "search", error: "invalid_pattern", query },
			}
		}
		for (const [serverName, metadata] of state.toolMetadata.entries()) {
			if (server && serverName !== server) continue
			for (const tool of metadata) {
				if (pattern.test(tool.name) || pattern.test(tool.description)) {
					matches.push({ server: serverName, tool })
				}
			}
		}
	}

	const totalCount = piMatches.length + matches.length

	if (totalCount === 0) {
		const msg = server ? `No tools matching "${query}" in "${server}"` : `No tools matching "${query}"`
		return {
			content: [{ type: "text" as const, text: msg }],
			details: { mode: "search", matches: [], count: 0, query },
		}
	}

	// Apply limit: fill from piMatches first, then MCP matches
	const piLimit = Math.min(piMatches.length, limit)
	const mcpLimit = Math.min(matches.length, limit - piLimit)
	const limitedPiMatches = piMatches.slice(0, piLimit)
	const limitedMatches = matches.slice(0, mcpLimit)
	const shownCount = limitedPiMatches.length + limitedMatches.length
	const truncated = totalCount > shownCount

	// Inject matched MCP tools as native pi tools for the next turn
	let injectedNames: string[] = []
	if (onInject && limitedMatches.length > 0) {
		const specs: DirectToolSpec[] = limitedMatches
			.filter((m) => !m.tool.resourceUri)
			.map((m) => ({
				serverName: m.server,
				originalName: m.tool.name,
				prefixedName: m.tool.name,
				description: m.tool.description ?? "",
				inputSchema: m.tool.inputSchema,
				uiResourceUri: m.tool.uiResourceUri,
				uiStreamMode: m.tool.uiStreamMode,
			}))
		if (specs.length > 0) injectedNames = onInject(specs)
	}

	let text = truncated
		? `Found ${totalCount} tool${totalCount === 1 ? "" : "s"} matching "${query}" (showing ${shownCount}, refine your query for more):\n\n`
		: `Found ${totalCount} tool${totalCount === 1 ? "" : "s"} matching "${query}":\n\n`

	for (const match of limitedPiMatches) {
		if (showSchemas) {
			text += `[pi tool] ${match.name}\n`
			text += `  ${match.description || "(no description)"}\n`
			text += `  No parameters (call directly).\n`
			text += "\n"
		} else {
			text += `[pi tool] ${match.name}`
			if (match.description) {
				text += ` - ${truncateAtWord(match.description, 50)}`
			}
			text += "\n"
		}
	}

	for (const match of limitedMatches) {
		if (showSchemas) {
			text += `${match.tool.name}\n`
			text += `  ${match.tool.description || "(no description)"}\n`
			if (match.tool.inputSchema && !match.tool.resourceUri) {
				text += `\n  Parameters:\n${formatSchema(match.tool.inputSchema, "    ")}\n`
			} else if (match.tool.resourceUri) {
				text += `  No parameters (resource tool).\n`
			}
			text += "\n"
		} else {
			text += `- ${match.tool.name}`
			if (match.tool.description) {
				text += ` - ${truncateAtWord(match.tool.description, 50)}`
			}
			text += "\n"
		}
	}

	if (injectedNames.length > 0) {
		text += `\nInjected into context. Call using the exact names shown above (do NOT add any prefix): ${injectedNames.join(", ")}`
	}

	return {
		content: [{ type: "text" as const, text: text.trim() }],
		details: {
			mode: "search",
			matches: [
				...limitedPiMatches.map((m) => ({ server: "pi", tool: m.name })),
				...limitedMatches.map((m) => ({ server: m.server, tool: m.tool.name })),
			],
			count: totalCount,
			shown: shownCount,
			query,
			injected: injectedNames,
		},
	}
}

export function executeList(state: McpExtensionState, server: string): ProxyToolResult {
	if (!state.config.mcpServers[server]) {
		return {
			content: [{ type: "text" as const, text: `Server "${server}" not found. Use mcp({}) to see available servers.` }],
			details: { mode: "list", server, tools: [], count: 0, error: "not_found" },
		}
	}

	const metadata = state.toolMetadata.get(server)
	const toolNames = metadata?.map((m) => m.name) ?? []
	const connection = state.manager.getConnection(server)

	if (toolNames.length === 0) {
		if (connection?.status === "connected") {
			return {
				content: [{ type: "text" as const, text: `Server "${server}" has no tools.` }],
				details: { mode: "list", server, tools: [], count: 0 },
			}
		}
		if (metadata !== undefined) {
			return {
				content: [{ type: "text" as const, text: `Server "${server}" has no cached tools (not connected).` }],
				details: { mode: "list", server, tools: [], count: 0, cached: true },
			}
		}
		return {
			content: [
				{
					type: "text" as const,
					text: `Server "${server}" is configured but not connected. Use mcp({ connect: "${server}" }) or /mcp reconnect ${server} to retry.`,
				},
			],
			details: { mode: "list", server, tools: [], count: 0, error: "not_connected" },
		}
	}

	const cachedNote = connection?.status === "connected" ? "" : " (not connected, cached)"
	let text = `${server} (${toolNames.length} tools${cachedNote}):\n\n`

	const descMap = new Map<string, string>()
	if (metadata) {
		for (const m of metadata) {
			descMap.set(m.name, m.description)
		}
	}

	for (const tool of toolNames) {
		const desc = descMap.get(tool) ?? ""
		const truncated = truncateAtWord(desc, 50)
		text += `- ${tool}`
		if (truncated) text += ` - ${truncated}`
		text += "\n"
	}

	return {
		content: [{ type: "text" as const, text: text.trim() }],
		details: { mode: "list", server, tools: toolNames, count: toolNames.length },
	}
}

export async function executeConnect(state: McpExtensionState, serverName: string): Promise<ProxyToolResult> {
	const definition = state.config.mcpServers[serverName]
	if (!definition) {
		return {
			content: [
				{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` },
			],
			details: { mode: "connect", error: "not_found", server: serverName },
		}
	}

	try {
		if (state.ui) {
			state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`)
		}
		let connection = await state.manager.connect(serverName, definition)
		if (connection.status === "needs-auth") {
			const autoAuth = await attemptAutoAuth(state, serverName)
			if (autoAuth.status === "failed") {
				return {
					content: [{ type: "text" as const, text: autoAuth.message }],
					details: { mode: "connect", error: "auth_required", server: serverName, message: autoAuth.message },
				}
			}
			if (autoAuth.status === "success") {
				await state.manager.close(serverName)
				connection = await state.manager.connect(serverName, definition)
			}
			if (connection.status === "needs-auth") {
				const message = getAuthRequiredMessage(serverName)
				return {
					content: [{ type: "text" as const, text: message }],
					details: { mode: "connect", error: "auth_required", server: serverName, message },
				}
			}
		}
		const prefix = state.config.settings?.toolPrefix ?? "server"
		const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix)
		state.toolMetadata.set(serverName, metadata)
		updateMetadataCache(state, serverName)
		state.failureTracker.delete(serverName)
		updateStatusBar(state)
		return executeList(state, serverName)
	} catch (error) {
		state.failureTracker.set(serverName, Date.now())
		updateStatusBar(state)
		const message = error instanceof Error ? error.message : String(error)
		return {
			content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
			details: { mode: "connect", error: "connect_failed", server: serverName, message },
		}
	}
}

export async function executeCall(
	state: McpExtensionState,
	toolName: string,
	args?: Record<string, unknown>,
	serverOverride?: string,
	ctx?: ExtensionContext,
	maxToolResultChars?: number,
): Promise<ProxyToolResult> {
	let serverName: string | undefined = serverOverride
	let toolMeta: ToolMetadata | undefined
	let autoAuthAttempted = false
	const prefixMode = state.config.settings?.toolPrefix ?? "server"

	if (serverName && !state.config.mcpServers[serverName]) {
		return {
			content: [
				{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` },
			],
			details: { mode: "call", error: "server_not_found", server: serverName },
		}
	}

	if (serverName) {
		toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName)
	} else {
		for (const [server, metadata] of state.toolMetadata.entries()) {
			const found = findToolByName(metadata, toolName)
			if (found) {
				serverName = server
				toolMeta = found
				break
			}
		}
	}

	if (serverName && !toolMeta) {
		const connected = await lazyConnect(state, serverName)
		if (connected) {
			toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName)
		} else {
			const needsAuthConnection = state.manager.getConnection(serverName)
			if (needsAuthConnection?.status === "needs-auth") {
				if (!autoAuthAttempted) {
					autoAuthAttempted = true
					const autoAuth = await attemptAutoAuth(state, serverName)
					if (autoAuth.status === "failed") {
						return {
							content: [{ type: "text" as const, text: autoAuth.message }],
							details: { mode: "call", error: "auth_required", server: serverName, message: autoAuth.message },
						}
					}
					if (autoAuth.status === "success") {
						await state.manager.close(serverName)
						state.failureTracker.delete(serverName)
						const connectedAfterAuth = await lazyConnect(state, serverName)
						if (connectedAfterAuth) {
							toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName)
							if (!toolMeta) {
								throw new Error(`Tool "${toolName}" not found on "${serverName}" after reconnect.`)
							}
						}
					}
				}

				if (!toolMeta && state.manager.getConnection(serverName)?.status === "needs-auth") {
					const message = getAuthRequiredMessage(serverName)
					return {
						content: [{ type: "text" as const, text: message }],
						details: { mode: "call", error: "auth_required", server: serverName, message },
					}
				}
			}

			if (!toolMeta) {
				const failedAgo = getFailureAgeSeconds(state, serverName)
				if (failedAgo !== null) {
					return {
						content: [
							{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` },
						],
						details: { mode: "call", error: "server_backoff", server: serverName },
					}
				}
			}
		}
	}

	let prefixMatchedServer: string | undefined

	if (!serverName && !toolMeta && prefixMode !== "none") {
		const candidates = Object.keys(state.config.mcpServers)
			.map((name) => ({ name, prefix: getServerPrefix(name, prefixMode) }))
			.filter((c) => c.prefix && toolName.startsWith(c.prefix + "_"))
			.sort((a, b) => b.prefix.length - a.prefix.length)

		for (const { name: configuredServer } of candidates) {
			const existingConnection = state.manager.getConnection(configuredServer)
			const failedAgo = getFailureAgeSeconds(state, configuredServer)
			if (failedAgo !== null && existingConnection?.status !== "needs-auth") continue

			let connected = await lazyConnect(state, configuredServer)
			if (!connected && state.manager.getConnection(configuredServer)?.status === "needs-auth" && !autoAuthAttempted) {
				autoAuthAttempted = true
				const autoAuth = await attemptAutoAuth(state, configuredServer)
				if (autoAuth.status === "failed") {
					return {
						content: [{ type: "text" as const, text: autoAuth.message }],
						details: { mode: "call", error: "auth_required", server: configuredServer, message: autoAuth.message },
					}
				}
				if (autoAuth.status === "success") {
					await state.manager.close(configuredServer)
					state.failureTracker.delete(configuredServer)
					connected = await lazyConnect(state, configuredServer)
				}
			}

			if (!connected) continue
			if (!prefixMatchedServer) prefixMatchedServer = configuredServer
			toolMeta = findToolByName(state.toolMetadata.get(configuredServer), toolName)
			if (toolMeta) {
				serverName = configuredServer
				break
			}
		}
	}

	if (!serverName || !toolMeta) {
		const hintServer = serverName ?? prefixMatchedServer
		const available = hintServer ? getToolNames(state, hintServer) : []
		let msg = `Tool "${toolName}" not found.`
		if (available.length > 0) {
			msg += ` Server "${hintServer}" has: ${available.join(", ")}`
		} else {
			msg += ` Use mcp({ search: "..." }) to search.`
		}
		throw new Error(msg)
	}

	let connection = state.manager.getConnection(serverName)
	if (connection?.status === "needs-auth") {
		if (!autoAuthAttempted) {
			autoAuthAttempted = true
			const autoAuth = await attemptAutoAuth(state, serverName)
			if (autoAuth.status === "failed") {
				return {
					content: [{ type: "text" as const, text: autoAuth.message }],
					details: { mode: "call", error: "auth_required", server: serverName, message: autoAuth.message },
				}
			}
			if (autoAuth.status === "success") {
				await state.manager.close(serverName)
				state.failureTracker.delete(serverName)
				connection = state.manager.getConnection(serverName)
			}
		}

		if (connection?.status === "needs-auth") {
			const message = getAuthRequiredMessage(serverName)
			return {
				content: [{ type: "text" as const, text: message }],
				details: { mode: "call", error: "auth_required", server: serverName, message },
			}
		}
	}
	if (!connection || connection.status !== "connected") {
		const failedAgo = getFailureAgeSeconds(state, serverName)
		if (failedAgo !== null) {
			return {
				content: [
					{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` },
				],
				details: { mode: "call", error: "server_backoff", server: serverName },
			}
		}

		const definition = state.config.mcpServers[serverName]
		if (!definition) {
			return {
				content: [{ type: "text" as const, text: `Server "${serverName}" not connected` }],
				details: { mode: "call", error: "server_not_connected", server: serverName },
			}
		}

		let toolNotFoundAfterReconnect: string | undefined
		try {
			if (state.ui) {
				state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`)
			}
			connection = await state.manager.connect(serverName, definition)
			if (connection.status === "needs-auth") {
				if (!autoAuthAttempted) {
					autoAuthAttempted = true
					const autoAuth = await attemptAutoAuth(state, serverName)
					if (autoAuth.status === "failed") {
						return {
							content: [{ type: "text" as const, text: autoAuth.message }],
							details: { mode: "call", error: "auth_required", server: serverName, message: autoAuth.message },
						}
					}
					if (autoAuth.status === "success") {
						await state.manager.close(serverName)
						connection = await state.manager.connect(serverName, definition)
					}
				}

				if (connection.status === "needs-auth") {
					const message = getAuthRequiredMessage(serverName)
					return {
						content: [{ type: "text" as const, text: message }],
						details: { mode: "call", error: "auth_required", server: serverName, message },
					}
				}
			}
			state.failureTracker.delete(serverName)
			updateServerMetadata(state, serverName)
			updateMetadataCache(state, serverName)
			updateStatusBar(state)
			toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName)
			if (!toolMeta) {
				const available = getToolNames(state, serverName)
				const hint =
					available.length > 0
						? `Available tools on "${serverName}": ${available.join(", ")}`
						: `Server "${serverName}" has no tools.`
				toolNotFoundAfterReconnect = `Tool "${toolName}" not found on "${serverName}" after reconnect. ${hint}`
			}
		} catch (error) {
			state.failureTracker.set(serverName, Date.now())
			updateStatusBar(state)
			const message = error instanceof Error ? error.message : String(error)
			return {
				content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
				details: { mode: "call", error: "connect_failed", message },
			}
		}
		if (toolNotFoundAfterReconnect) {
			throw new Error(toolNotFoundAfterReconnect)
		}
	}

	if (!toolMeta) {
		throw new Error(`Tool "${toolName}" not found.`)
	}

	let uiSession: UiSessionRuntime | null = null

	try {
		state.manager.touch(serverName)
		state.manager.incrementInFlight(serverName)

		if (toolMeta.resourceUri) {
			const result = await connection.client.readResource({ uri: toolMeta.resourceUri })
			const content = (result.contents ?? []).map((c) => ({
				type: "text" as const,
				text:
					"text" in c
						? c.text
						: "blob" in c
							? `[Binary data: ${(c as { mimeType?: string }).mimeType ?? "unknown"}]`
							: JSON.stringify(c),
			}))
			return {
				content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }],
				details: { mode: "call", resourceUri: toolMeta.resourceUri, server: serverName },
			}
		}

		uiSession = toolMeta.uiResourceUri
			? await maybeStartUiSession(state, {
					serverName,
					toolName: toolMeta.originalName,
					toolArgs: args ?? {},
					uiResourceUri: toolMeta.uiResourceUri,
					streamMode: toolMeta.uiStreamMode,
				})
			: null

		const resultPromise = connection.client.callTool({
			name: toolMeta.originalName,
			arguments: args ?? {},
			_meta: uiSession?.requestMeta,
		})

		if (toolMeta.uiResourceUri) {
			const result = await resultPromise
			uiSession?.sendToolResult(result as unknown as CallToolResult)
			const mcpContent = (result.content ?? []) as McpContent[]
			const content = transformMcpContent(mcpContent)

			const mcpText = content
				.filter((c) => c.type === "text")
				.map((c) => (c as { text: string }).text)
				.join("\n")

			if (result.isError) {
				let errorWithSchema = `Error: ${mcpText || "Tool execution failed"}`
				if (toolMeta.inputSchema) {
					errorWithSchema += `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`
				}
				return {
					content: [{ type: "text" as const, text: errorWithSchema }],
					details: { mode: "call", error: "tool_error", mcpResult: result },
				}
			}

			const resultText = mcpText || "(empty result)"
			const uiMessage = uiSession?.reused
				? "Updated the open UI."
				: "📺 Interactive UI is now open in your browser. I'll respond to your prompts and intents as you interact with it."
			return {
				content: [{ type: "text" as const, text: `${resultText}\n\n${uiMessage}` }],
				details: { mode: "call", mcpResult: result, server: serverName, tool: toolMeta.originalName, uiOpen: true },
			}
		}

		const result = await resultPromise

		const mcpContent = (result.content ?? []) as McpContent[]
		const content = transformMcpContent(mcpContent)

		if (result.isError) {
			const errorText =
				content
					.filter((c) => c.type === "text")
					.map((c) => (c as { text: string }).text)
					.join("\n") || "Tool execution failed"

			let errorWithSchema = `Error: ${errorText}`
			if (toolMeta.inputSchema) {
				errorWithSchema += `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`
			}

			return {
				content: [{ type: "text" as const, text: errorWithSchema }],
				details: { mode: "call", error: "tool_error", mcpResult: result },
			}
		}

		const finalContent = (content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }]) as ContentBlock[]
		const truncated = ctx
			? applyOffload(finalContent, toolName, maxToolResultChars ?? 10_000, ctx)
			: applyTruncation(finalContent)
		return {
			content: truncated,
			details: { mode: "call", mcpResult: result, server: serverName, tool: toolMeta.originalName },
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		uiSession?.sendToolCancelled(message)

		let errorWithSchema = `Failed to call tool: ${message}`
		if (toolMeta.inputSchema) {
			errorWithSchema += `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`
		}

		return {
			content: [{ type: "text" as const, text: errorWithSchema }],
			details: { mode: "call", error: "call_failed", message },
		}
	} finally {
		if (uiSession?.reused) {
			uiSession.close()
		}
		state.manager.decrementInFlight(serverName)
		state.manager.touch(serverName)
	}
}
