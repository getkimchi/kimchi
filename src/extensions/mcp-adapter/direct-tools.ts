import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { fillMissingRequired } from "./context-providers.js"
import { getFailureAgeSeconds, lazyConnect } from "./init.js"
import { authenticate, supportsOAuth } from "./mcp-auth-flow.js"
import type { MetadataCache } from "./metadata-cache.js"
import { isServerCacheValid } from "./metadata-cache.js"
import { resourceNameToToolName } from "./resource-tools.js"
import type { McpExtensionState } from "./state.js"
import { formatSchema } from "./tool-metadata.js"
import { transformMcpContent } from "./tool-registrar.js"
import type { DirectToolSpec, McpConfig, McpContent } from "./types.js"
import { formatToolName, isToolExcluded } from "./types.js"
import { type UiSessionRuntime, maybeStartUiSession } from "./ui-session.js"

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"])

type DirectAutoAuthResult = { status: "skipped" } | { status: "success" } | { status: "failed"; message: string }

async function attemptDirectAutoAuth(state: McpExtensionState, serverName: string): Promise<DirectAutoAuthResult> {
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
			message: `MCP server "${serverName}" requires OAuth authentication. Run /mcp-auth ${serverName} in an interactive session.`,
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

export function resolveDirectTools(
	config: McpConfig,
	cache: MetadataCache | null,
	prefix: "server" | "none" | "short",
	envOverride?: string[],
): DirectToolSpec[] {
	const specs: DirectToolSpec[] = []
	if (!cache) return specs

	const seenNames = new Set<string>()

	const envServers = new Set<string>()
	const envTools = new Map<string, Set<string>>()
	if (envOverride) {
		for (let item of envOverride) {
			item = item.replace(/\/+$/, "")
			if (item.includes("/")) {
				const [server, tool] = item.split("/", 2)
				if (server && tool) {
					if (!envTools.has(server)) envTools.set(server, new Set())
					envTools.get(server)!.add(tool)
				} else if (server) {
					envServers.add(server)
				}
			} else if (item) {
				envServers.add(item)
			}
		}
	}

	const globalDirect = config.settings?.directTools

	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		const serverCache = cache.servers[serverName]
		if (!serverCache || !isServerCacheValid(serverCache, definition)) continue

		let toolFilter: true | string[] | false = false

		if (envOverride) {
			if (envServers.has(serverName)) {
				toolFilter = true
			} else if (envTools.has(serverName)) {
				toolFilter = [...envTools.get(serverName)!]
			}
		} else {
			if (definition.directTools !== undefined) {
				toolFilter = definition.directTools
			} else if (globalDirect) {
				toolFilter = globalDirect
			}
		}

		if (!toolFilter) continue

		for (const tool of serverCache.tools ?? []) {
			if (toolFilter !== true && !toolFilter.includes(tool.name)) continue
			if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) continue
			const prefixedName = formatToolName(tool.name, serverName, prefix)
			if (BUILTIN_NAMES.has(prefixedName)) {
				console.warn(`MCP: skipping direct tool "${prefixedName}" (collides with builtin)`)
				continue
			}
			if (seenNames.has(prefixedName)) {
				console.warn(`MCP: skipping duplicate direct tool "${prefixedName}" from "${serverName}"`)
				continue
			}
			seenNames.add(prefixedName)
			specs.push({
				serverName,
				originalName: tool.name,
				prefixedName,
				description: tool.description ?? "",
				inputSchema: tool.inputSchema,
				uiResourceUri: tool.uiResourceUri,
				uiStreamMode: tool.uiStreamMode,
			})
		}

		if (definition.exposeResources !== false) {
			for (const resource of serverCache.resources ?? []) {
				const baseName = `get_${resourceNameToToolName(resource.name)}`
				if (toolFilter !== true && !toolFilter.includes(baseName)) continue
				if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) continue
				const prefixedName = formatToolName(baseName, serverName, prefix)
				if (BUILTIN_NAMES.has(prefixedName)) {
					console.warn(`MCP: skipping direct resource tool "${prefixedName}" (collides with builtin)`)
					continue
				}
				if (seenNames.has(prefixedName)) {
					console.warn(`MCP: skipping duplicate direct resource tool "${prefixedName}" from "${serverName}"`)
					continue
				}
				seenNames.add(prefixedName)
				specs.push({
					serverName,
					originalName: baseName,
					prefixedName,
					description: resource.description ?? `Read resource: ${resource.uri}`,
					resourceUri: resource.uri,
				})
			}
		}
	}

	return specs
}

export function getMissingConfiguredDirectToolServers(config: McpConfig, cache: MetadataCache | null): string[] {
	const missing: string[] = []
	const globalDirect = config.settings?.directTools

	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		const hasDirectTools = definition.directTools !== undefined ? !!definition.directTools : !!globalDirect

		if (!hasDirectTools) continue

		const serverCache = cache?.servers?.[serverName]
		if (!serverCache || !isServerCacheValid(serverCache, definition)) {
			missing.push(serverName)
		}
	}

	return missing
}

export function buildProxyDescription(
	config: McpConfig,
	cache: MetadataCache | null,
	directSpecs: DirectToolSpec[],
): string {
	const prefix = config.settings?.toolPrefix ?? "server"
	let desc = `MCP gateway - connect to MCP servers and call their tools.\n`

	const directByServer = new Map<string, number>()
	for (const spec of directSpecs) {
		directByServer.set(spec.serverName, (directByServer.get(spec.serverName) ?? 0) + 1)
	}
	if (directByServer.size > 0) {
		const parts = [...directByServer.entries()].map(([server, count]) => `${server} (${count})`)
		desc += `\nDirect tools available (call as normal tools): ${parts.join(", ")}\n`
	}

	const serverSummaries: string[] = []
	for (const serverName of Object.keys(config.mcpServers)) {
		const entry = cache?.servers?.[serverName]
		const definition = config.mcpServers[serverName]
		const toolCount = (entry?.tools ?? []).filter(
			(tool) => !isToolExcluded(tool.name, serverName, prefix, definition.excludeTools),
		).length
		const resourceCount =
			definition?.exposeResources !== false
				? (entry?.resources ?? []).filter((resource) => {
						const baseName = `get_${resourceNameToToolName(resource.name)}`
						return !isToolExcluded(baseName, serverName, prefix, definition.excludeTools)
					}).length
				: 0
		const totalItems = toolCount + resourceCount
		if (totalItems === 0) continue
		const directCount = directByServer.get(serverName) ?? 0
		const proxyCount = totalItems - directCount
		if (proxyCount > 0) {
			serverSummaries.push(`${serverName} (${proxyCount} tools)`)
		}
	}

	if (serverSummaries.length > 0) {
		desc += `\nServers: ${serverSummaries.join(", ")}\n`
	}

	desc += `\nUsage:\n`
	desc += `  mcp({ search: "query" })              → ALWAYS START HERE. Search tools by name/description. Injects matched tool schemas into context so you can call them directly.\n`
	desc += `  mcp({ describe: "tool_name" })        → Get full schema for a specific tool. Use when you know the tool name but need its parameters.\n`
	desc += `  mcp({ tool: "name", args: '{"key": "value"}' })    → Call a tool by proxy (args is JSON string). Prefer calling injected tools directly after search/describe.\n`
	desc += `  mcp({ connect: "server-name" })       → Connect to a server and refresh metadata\n`
	desc += `  mcp({ action: "ui-messages" })        → Retrieve accumulated messages from completed UI sessions\n`
	desc += `\nWorkflow: search → schemas injected → call tool directly (do NOT guess parameters without searching first)`

	return desc
}

type DirectToolExecute = ToolDefinition["execute"]

export function createDirectToolExecutor(
	getState: () => McpExtensionState | null,
	getInitPromise: () => Promise<McpExtensionState> | null,
	spec: DirectToolSpec,
	ctx?: Pick<ExtensionContext, "cwd">,
): DirectToolExecute {
	return async function execute(_toolCallId, params) {
		let state = getState()
		const initPromise = getInitPromise()

		if (!state && initPromise) {
			try {
				state = await initPromise
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return {
					content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
					details: { error: "init_failed", message },
				}
			}
		}
		if (!state) {
			return {
				content: [{ type: "text" as const, text: "MCP not initialized" }],
				details: { error: "not_initialized" },
			}
		}

		let connected = await lazyConnect(state, spec.serverName)
		let autoAuthAttempted = false

		if (!connected && state.manager.getConnection(spec.serverName)?.status === "needs-auth") {
			autoAuthAttempted = true
			const autoAuth = await attemptDirectAutoAuth(state, spec.serverName)
			if (autoAuth.status === "failed") {
				return {
					content: [{ type: "text" as const, text: autoAuth.message }],
					details: { error: "auth_required", server: spec.serverName, message: autoAuth.message },
				}
			}
			if (autoAuth.status === "success") {
				await state.manager.close(spec.serverName)
				state.failureTracker.delete(spec.serverName)
				connected = await lazyConnect(state, spec.serverName)
			}
		}

		if (!connected) {
			const authConnection = state.manager.getConnection(spec.serverName)
			if (authConnection?.status === "needs-auth") {
				const message = `MCP server "${spec.serverName}" requires OAuth authentication. Run /mcp-auth ${spec.serverName} first.`
				return {
					content: [{ type: "text" as const, text: message }],
					details: { error: "auth_required", server: spec.serverName, message, autoAuthAttempted },
				}
			}
			const failedAgo = getFailureAgeSeconds(state, spec.serverName)
			return {
				content: [
					{
						type: "text" as const,
						text: `MCP server "${spec.serverName}" not available${failedAgo !== null ? ` (failed ${failedAgo}s ago)` : ""}`,
					},
				],
				details: { error: "server_unavailable", server: spec.serverName },
			}
		}

		const connection = state.manager.getConnection(spec.serverName)
		if (!connection || connection.status !== "connected") {
			return {
				content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not connected` }],
				details: { error: "not_connected", server: spec.serverName },
			}
		}

		const mergedArgs = fillMissingRequired(
			spec.metadata,
			(params ?? {}) as Record<string, unknown>,
			ctx ?? { cwd: process.cwd() },
			(msg) => console.debug(msg),
		)

		let uiSession: UiSessionRuntime | null = null

		try {
			state.manager.touch(spec.serverName)
			state.manager.incrementInFlight(spec.serverName)

			if (spec.resourceUri) {
				const result = await connection.client.readResource({ uri: spec.resourceUri })
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
					details: { server: spec.serverName, resourceUri: spec.resourceUri },
				}
			}

			const hasUi = !!spec.uiResourceUri
			uiSession = hasUi
				? await maybeStartUiSession(state, {
						serverName: spec.serverName,
						toolName: spec.originalName,
						toolArgs: mergedArgs,
						uiResourceUri: spec.uiResourceUri!,
						streamMode: spec.uiStreamMode,
					})
				: null

			const result = await connection.client.callTool({
				name: spec.originalName,
				arguments: mergedArgs,
				_meta: uiSession?.requestMeta,
			})
			uiSession?.sendToolResult(result as unknown as CallToolResult)

			const mcpContent = (result.content ?? []) as McpContent[]
			const content = transformMcpContent(mcpContent)

			if (result.isError) {
				let errorText =
					content
						.filter((c) => c.type === "text")
						.map((c) => (c as { text: string }).text)
						.join("\n") || "Tool execution failed"
				if (spec.inputSchema) {
					errorText += `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}`
				}
				return {
					content: [{ type: "text" as const, text: `Error: ${errorText}` }],
					details: { error: "tool_error", server: spec.serverName },
				}
			}

			const resultText =
				content
					.filter((c) => c.type === "text")
					.map((c) => (c as { text: string }).text)
					.join("\n") || "(empty result)"
			if (hasUi) {
				const uiMessage = uiSession?.reused
					? "Updated the open UI."
					: "📺 Interactive UI is now open in your browser. I'll respond to your prompts and intents as you interact with it."
				return {
					content: [{ type: "text" as const, text: `${resultText}\n\n${uiMessage}` }],
					details: { server: spec.serverName, tool: spec.originalName, uiOpen: true },
				}
			}

			return {
				content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }],
				details: { server: spec.serverName, tool: spec.originalName },
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			uiSession?.sendToolCancelled(message)
			let errorText = `Failed to call tool: ${message}`
			if (spec.inputSchema) {
				errorText += `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}`
			}
			return {
				content: [{ type: "text" as const, text: errorText }],
				details: { error: "call_failed", server: spec.serverName },
			}
		} finally {
			if (uiSession?.reused) {
				uiSession.close()
			}
			state.manager.decrementInFlight(spec.serverName)
			state.manager.touch(spec.serverName)
		}
	}
}
