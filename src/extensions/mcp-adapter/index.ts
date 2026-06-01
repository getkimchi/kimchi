import type { ExtensionAPI, ExtensionContext, ToolInfo, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent"
import { Theme, keyHint } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { DirectToolSpec, ToolMetadata } from "./types.js"
import { type Component, Text } from "@earendil-works/pi-tui"
import { registerToolCall, isToolExpanded } from "../../expand-state.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { authenticateServer, openMcpPanel, reconnectServers, showStatus, showTools } from "./commands.js"
import { loadConfig } from "../../config.js"
import { BM25_DEFAULTS, buildStrategy, buildToolEntries } from "./bm25.js"
import { loadMcpConfig } from "./config.js"
import {
	buildProxyDescription,
	createDirectToolExecutor,
	getMissingConfiguredDirectToolServers,
	resolveDirectTools,
} from "./direct-tools.js"
import { createDirectToolVisibility } from "./direct-tool-visibility.js"
import { flushMetadataCache, initializeMcp, updateStatusBar } from "./init.js"
import { initializeOAuth, shutdownOAuth } from "./mcp-auth-flow.js"
import { loadMetadataCache, overwriteMetadataCache, purgeStaleEntries } from "./metadata-cache.js"
import {
	executeCall,
	executeConnect,
	executeDescribe,
	executeSearch,
	executeUiMessages,
} from "./proxy-modes.js"
import type { McpExtensionState } from "./state.js"
import { getConfigPathFromArgv, truncateAtWord } from "./utils.js"

const TOOL_AND_MCP_DISCOVERY_PROMPT = `## Tool and MCP Discovery

- Before resorting to web search, web fetch, or giving up on accessing external data, check your Available Tools list for a more direct way to get the information. MCP (Model Context Protocol) integrations often provide authenticated access to services like Jira, Confluence, GitHub, GitLab, and others that are inaccessible via unauthenticated web requests.
- If you see an mcp tool in your tool list, use mcp({ search: "query" }) to discover what MCP servers and tools are available before assuming you have no way to access a service.
- Prefer MCP tools over web_fetch for any service that requires authentication (Jira, Confluence, internal wikis, etc.). MCP tools already have credentials configured.`

export default function mcpAdapter(pi: ExtensionAPI) {
	let state: McpExtensionState | null = null
	let initPromise: Promise<McpExtensionState> | null = null
	let lifecycleGeneration = 0

	async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
		if (!currentState) return

		if (currentState.uiServer) {
			currentState.uiServer.close(reason)
			currentState.uiServer = null
		}

		let flushError: unknown
		try {
			flushMetadataCache(currentState)
		} catch (error) {
			flushError = error
		}

		try {
			await currentState.lifecycle.gracefulShutdown()
		} catch (error) {
			if (flushError) {
				console.error("MCP: graceful shutdown failed after metadata flush error", error)
			} else {
				throw error
			}
		}

		if (flushError) {
			throw flushError
		}
	}

	const earlyConfigPath = getConfigPathFromArgv()
	const { config: earlyConfig } = loadMcpConfig(earlyConfigPath)
	let earlyCache = loadMetadataCache()

	// Drop cache entries whose configHash no longer matches the configured server
	// definition, or whose server has been removed from config. Otherwise stale
	// entries silently block direct-tool registration on every startup.
	if (earlyCache) {
		const { cleaned, removed } = purgeStaleEntries(earlyCache, earlyConfig.mcpServers)
		if (removed.length > 0) {
			overwriteMetadataCache(cleaned)
			earlyCache = cleaned
			console.warn(`MCP: purged stale cache entries: ${removed.join(", ")}`)
		}
	}

	const prefix = earlyConfig.settings?.toolPrefix ?? "server"

	const envRaw = process.env.MCP_DIRECT_TOOLS
	const directSpecs =
		envRaw === "__none__"
			? []
			: resolveDirectTools(
					earlyConfig,
					earlyCache,
					prefix,
					envRaw
						?.split(",")
						.map((s) => s.trim())
						.filter(Boolean),
				)
	const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(earlyConfig, earlyCache)
	const shouldRegisterProxyTool =
		earlyConfig.settings?.disableProxyTool !== true ||
		directSpecs.length === 0 ||
		missingConfiguredDirectToolServers.length > 0

	// Track all registered tool names to avoid double-registration
	const registeredToolNames = new Set<string>()
	const directToolVisibility = createDirectToolVisibility(pi)

	for (const spec of directSpecs) {
		const cachedServer = earlyCache?.servers?.[spec.serverName]
		const cachedTool = cachedServer?.tools?.find((t) => t.name === spec.originalName)
		const metadata: ToolMetadata | undefined = cachedTool
			? {
					name: spec.prefixedName,
					originalName: spec.originalName,
					description: spec.description,
					inputSchema: cachedTool.inputSchema,
					uiResourceUri: cachedTool.uiResourceUri,
					uiStreamMode: cachedTool.uiStreamMode,
				}
			: undefined
		pi.registerTool({
			name: spec.prefixedName,
			label: `MCP: ${spec.originalName}`,
			description: spec.description || "(no description)",
			promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
			parameters: Type.Unsafe<Record<string, unknown>>(spec.inputSchema || { type: "object", properties: {} }),
			execute: createDirectToolExecutor(
				() => state,
				() => initPromise,
				{ ...spec, metadata },
			),
		})
		registeredToolNames.add(spec.prefixedName)
		directToolVisibility.markPermanent([spec.prefixedName])
	}

	/**
	 * Register tool specs with the agent and expose them in the active set.
	 *
	 * `markDynamic` (default true) tags the new names in `state.dynamicToolNames`
	 * so the next user input clears them (used by proxy describe/search results).
	 * Pass `false` for tools that should persist across turns — e.g. direct tools
	 * registered after a successful cache bootstrap. `pi.registerTool` activates
	 * newly registered tools; the visibility controller releases any prior
	 * transient hide when a previously registered dynamic tool is injected again.
	 *
	 * When `state` is not yet ready (callback invoked from inside `initializeMcp`
	 * before its promise resolves), we only allow the permanent path through —
	 * registering dynamic tools without a state to track them in would leak them
	 * across turns because the `pi.on("input", …)` clear couldn't find them.
	 * Permanent tools (`markDynamic: false`) are safe to register early: the
	 * executor captures `state` lazily via the `() => state` closure and the
	 * tools are meant to persist anyway.
	 */
	function registerAndActivate(
		specs: DirectToolSpec[],
		opts?: { markDynamic?: boolean },
		ctx?: Pick<ExtensionContext, "cwd">,
	): string[] {
		const markDynamic = opts?.markDynamic ?? true
		if (!state && markDynamic) return []
		const newNames: string[] = []
		const alreadyRegistered: string[] = []
		for (const spec of specs) {
			if (registeredToolNames.has(spec.prefixedName)) {
				alreadyRegistered.push(spec.prefixedName)
				continue
			}
			pi.registerTool({
				name: spec.prefixedName,
				label: `MCP: ${spec.originalName}`,
				description: spec.description || "(no description)",
				parameters: Type.Unsafe<Record<string, unknown>>(spec.inputSchema || { type: "object", properties: {} }),
				execute: createDirectToolExecutor(
					() => state,
					() => initPromise,
					spec,
					ctx,
				),
			})
			registeredToolNames.add(spec.prefixedName)
			newNames.push(spec.prefixedName)
		}
		const allInjected = [...alreadyRegistered, ...newNames]
		directToolVisibility.expose(allInjected, {
			markDynamic,
			dynamicToolNames: state?.dynamicToolNames,
		})
		return allInjected
	}

	/**
	 * Register direct-tool specs produced by the cache bootstrap path
	 * (`init.ts` → `resolveDirectTools` after first connect). These tools
	 * are permanent for the session, so they must not be marked dynamic.
	 */
	function registerBootstrappedDirectTools(
		specs: DirectToolSpec[],
		ctx?: Pick<ExtensionContext, "cwd">,
	): string[] {
		return registerAndActivate(specs, { markDynamic: false }, ctx)
	}

	pi.on("input", () => {
		if (!state || state.dynamicToolNames.size === 0) return
		directToolVisibility.hideDynamic(state.dynamicToolNames)
	})

	const getPiTools = (): ToolInfo[] => pi.getAllTools()
	const getNativeToolStatus = (toolName: string): { tool: ToolInfo; active: boolean } | undefined => {
		const tool = pi.getAllTools().find((candidate) => candidate.name === toolName)
		if (!tool) return undefined
		return { tool, active: pi.getActiveTools().includes(tool.name) }
	}

	pi.registerFlag("mcp-config", {
		description: "Path to MCP config file",
		type: "string",
	})

	createSystemPromptBlocks(pi, "mcp-adapter").register({
		id: "tool-and-mcp-discovery",
		render: () => TOOL_AND_MCP_DISCOVERY_PROMPT,
	})

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++lifecycleGeneration
		const previousState = state
		state = null
		initPromise = null

		try {
			await Promise.all([shutdownState(previousState, "session_restart"), shutdownOAuth()])
		} catch (error) {
			console.error("MCP: failed to shut down previous session state", error)
		}

		if (generation !== lifecycleGeneration) {
			return
		}

		await initializeOAuth().catch((err) => {
			console.error("MCP OAuth initialization failed:", err)
		})

		const promise = initializeMcp(pi, ctx, registerBootstrappedDirectTools)
		initPromise = promise

		promise
			.then(async (nextState) => {
				if (generation !== lifecycleGeneration || initPromise !== promise) {
					try {
						await shutdownState(nextState, "stale_session_start")
					} catch (error) {
						console.error("MCP: failed to clean stale session state", error)
					}
					return
				}

				state = nextState
				updateStatusBar(nextState)
				initPromise = null

				// Build search strategy from live tool metadata
				try {
					const kimchiConfig = loadConfig()
					const { strategy, bm25K1, bm25B, fieldWeights } = kimchiConfig.mcpSearch
					const entries = buildToolEntries(nextState.toolMetadata)
					state.searchStrategy = buildStrategy(entries, { strategy, k1: bm25K1, b: bm25B, fieldWeights })
				} catch {
					// loadConfig throws if no API key; fall back to default strategy
					const entries = buildToolEntries(nextState.toolMetadata)
					state.searchStrategy = buildStrategy(entries, BM25_DEFAULTS)
				}
			})
			.catch((err) => {
				if (generation !== lifecycleGeneration) {
					return
				}
				if (initPromise !== promise && initPromise !== null) {
					return
				}
				console.error("MCP initialization failed:", err)
				initPromise = null
			})
	})

	pi.on("session_shutdown", async () => {
		++lifecycleGeneration
		const currentState = state
		state = null
		initPromise = null

		try {
			await Promise.all([shutdownState(currentState, "session_shutdown"), shutdownOAuth()])
		} catch (error) {
			console.error("MCP: session shutdown cleanup failed", error)
		}
	})

	pi.registerCommand("mcp", {
		description: "Show MCP server status",
		handler: async (args, ctx) => {
			if (!state && initPromise) {
				try {
					state = await initPromise
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error")
					return
				}
			}
			if (!state) {
				if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error")
				return
			}

			const parts = args?.trim()?.split(/\s+/) ?? []
			const subcommand = parts[0] ?? ""
			const targetServer = parts[1]

			switch (subcommand) {
				case "reconnect":
					await reconnectServers(state, ctx, targetServer)
					break
				case "tools":
					await showTools(state, ctx)
					break
				case "status":
				case "":
				default:
					if (ctx.hasUI) {
						await openMcpPanel(state, pi, ctx, earlyConfigPath)
					} else {
						await showStatus(state, ctx)
					}
					break
			}
		},
	})

	pi.registerCommand("mcp-auth", {
		description: "Authenticate with an MCP server (OAuth)",
		handler: async (args, ctx) => {
			const serverName = args?.trim()
			if (!serverName) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /mcp-auth <server-name>", "error")
				return
			}

			if (!state && initPromise) {
				try {
					state = await initPromise
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error")
					return
				}
			}
			if (!state) {
				if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error")
				return
			}

			await authenticateServer(serverName, state.config, ctx)
		},
	})

	if (shouldRegisterProxyTool) {
		pi.registerTool({
			name: "mcp",
			label: "MCP",
			description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
			promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
			parameters: Type.Object({
				tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
				args: Type.Optional(Type.String({ description: 'Arguments as JSON string (e.g., \'{"key": "value"}\')' })),
				connect: Type.Optional(
					Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" }),
				),
				describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
				search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
				regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
				includeSchemas: Type.Optional(
					Type.Boolean({ description: "Include parameter schemas in search results (default: true)" }),
				),
				limit: Type.Optional(Type.Number({ description: "Max number of search results to return (default: 5)" })),
				server: Type.Optional(
					Type.String({ description: "Filter search/describe/call to a specific server" }),
				),
				action: Type.Optional(
					Type.String({ description: "Action: 'ui-messages' to retrieve prompts/intents from UI sessions" }),
				),
			}),
			async execute(
				_toolCallId,
				params: {
					tool?: string
					args?: string
					connect?: string
					describe?: string
					search?: string
					regex?: boolean
					includeSchemas?: boolean
					limit?: number
					server?: string
					action?: string
				},
				_signal,
				_onUpdate,
				ctx,
			) {
				let parsedArgs: Record<string, unknown> | undefined
				if (params.args) {
					try {
						parsedArgs = JSON.parse(params.args)
						if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
							const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs
							throw new Error(`Invalid args: expected a JSON object, got ${gotType}`)
						}
					} catch (error) {
						if (error instanceof SyntaxError) {
							throw new Error(`Invalid args JSON: ${error.message}`, { cause: error })
						}
						throw error
					}
				}

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

				if (params.action === "ui-messages") {
					return executeUiMessages(state)
				}
				let maxToolResultChars = 10_000
				try {
					const kimchiConfig = loadConfig()
					maxToolResultChars = kimchiConfig.maxToolResultChars
				} catch {
					// loadConfig throws when API key is missing; default is fine here
				}
				if (params.tool) {
					return executeCall(state, params.tool, parsedArgs, params.server, ctx, maxToolResultChars, getNativeToolStatus)
				}
				if (params.connect) {
					return executeConnect(state, params.connect)
				}
				if (params.describe) {
					return executeDescribe(
						state,
						params.describe,
						(specs) => registerAndActivate(specs, undefined, ctx),
						getNativeToolStatus,
					)
				}
				if (params.search) {
					let mcpSearchLimit = 5
				try {
					const kimchiConfig = loadConfig()
					mcpSearchLimit = kimchiConfig.mcpSearchLimit
				} catch {
					// no API key configured; default is fine
				}
				return executeSearch(state, params.search, params.regex, params.server, params.includeSchemas, getPiTools, params.limit ?? mcpSearchLimit, state.searchStrategy, (specs) =>
					registerAndActivate(specs, undefined, ctx)
				)
				}
				return {
					content: [{ type: "text" as const, text: `Workflow Error: Missing action parameter.\nTo use MCP tools, you must first discover them and their schemas.\nUse mcp({ search: "..." }) to find tools, or mcp({ describe: "tool_name" }) to get a schema. Matched tools will then be injected for you to call directly.` }],
					details: { error: "missing_action" },
				}
			},
			renderCall(args: { tool?: string; args?: string; connect?: string; describe?: string; search?: string; limit?: number; server?: string; action?: string }, theme: Theme, context: { lastComponent: Component | undefined }) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0)
				text.setText(formatMcpCall(args, theme))
				return text
			},
			renderResult(result: unknown, options: ToolRenderResultOptions, theme: Theme, context: { lastComponent: Component | undefined; toolCallId: string }) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0)
				registerToolCall(context.toolCallId)
				const expanded = isToolExpanded(context.toolCallId)
				text.setText(formatMcpResult(result, expanded, theme))
				return text
			},
		})
	}
}

const COLLAPSED_LINES = 10

function formatMcpResult(result: unknown, expanded: boolean, theme: Theme): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> })?.content ?? []
	const textParts = content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
	const combined = textParts.join("\n")
	if (!combined) return ""

	const lines = combined.split("\n")
	const maxLines = expanded ? lines.length : COLLAPSED_LINES
	const displayLines = lines.slice(0, maxLines)
	const remaining = lines.length - maxLines

	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`
	}
	return text
}

function formatMcpCall(
	params: { tool?: string; args?: string; connect?: string; describe?: string; search?: string; limit?: number; server?: string; action?: string },
	theme: Theme,
): string {
	if (params.tool) {
		// Parse server prefix from tool name: "grafana_prod_master_query_loki" -> server="grafana_prod_master", tool="query_loki"
		// We display as-is since the full prefixed name is what the model uses
		const toolDisplay = theme.fg("accent", params.tool)
		let argsDisplay = ""
		if (params.args) {
			try {
				const parsed = JSON.parse(params.args) as Record<string, unknown>
				const parts = Object.entries(parsed).map(([k, v]) => {
					const val = typeof v === "string" ? v.slice(0, 60) + (v.length > 60 ? "…" : "") : String(v).slice(0, 60)
					return `${theme.fg("muted", k + ":")} ${theme.fg("toolOutput", val)}`
				})
				if (parts.length > 0) argsDisplay = `(${parts.join(", ")})`
			} catch {
				argsDisplay = `(${theme.fg("toolOutput", params.args.slice(0, 80))})`
			}
		}
		return `${theme.bold("mcp")} ${toolDisplay}${argsDisplay}`
	}
	if (params.describe) return `${theme.bold("mcp")} ${theme.fg("muted", "describe:")} ${theme.fg("accent", params.describe)}`
	if (params.search) {
		const limitSuffix = params.limit !== undefined ? theme.fg("muted", ` (limit:${params.limit})`) : ""
		return `${theme.bold("mcp")} ${theme.fg("muted", "search:")} ${theme.fg("toolOutput", params.search)}${limitSuffix}`
	}
	if (params.connect) return `${theme.bold("mcp")} ${theme.fg("muted", "connect:")} ${theme.fg("accent", params.connect)}`
	if (params.server) return `${theme.bold("mcp")} ${theme.fg("muted", "server:")} ${theme.fg("accent", params.server)}`
	if (params.action === "ui-messages") return `${theme.bold("mcp")} ${theme.fg("muted", "ui-messages")}`
	return theme.bold("mcp")
}
