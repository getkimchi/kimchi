import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionHandler,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent"

import type { McpRuntimeRegistrationRequest } from "pi-mcp-adapter"
import {
	createMcpAdapter,
	MCP_RUNTIME_REGISTER_EVENT,
	MCP_RUNTIME_REGISTER_VERSION,
	MCP_STATUS_EVENT,
} from "pi-mcp-adapter"
import type { McpAdapterOptions, McpConfig, ServerCacheEntry, ServerEntry } from "pi-mcp-adapter/types"
import { getParsedCliArgs } from "../../cli-args.js"
import { getConfiguredLegacyMcpKeys } from "../../config.js"
import {
	applyCooperativeTweak,
	debugToolSurface,
	getCurrentProfile,
	reapplyCurrentProfile,
	registerReadOnlyToolProvider,
} from "../../shared/planning/tool-profile-manager.js"
import { notifyUser } from "../../utils/notify-user.js"
import { isActionBlockedError } from "../deferred-action.js"
import { getPermissionMode } from "../permissions/mode-controller.js"
import { createToolVisibility } from "../prompt-construction/tool-visibility.js"
import { observeToolFiles } from "../work-attribution/file-observations.js"
import { DEFAULT_MCP_PROTOCOL_VERSION, getSharedMcpConfigPath, loadKimchiMcpConfig } from "./config.js"
import type { BuiltInGatewayServer } from "./gateway.js"
import { buildBuiltinGatewayServer, getGatewayAddresses, hasGatewayAddress } from "./gateway.js"
import { installKeyringRequireBridge } from "./keyring-require-bridge.js"
import {
	brandMcpAdapterOwnedToolResult,
	brandMcpAdapterText,
	createBrandedMcpContext,
	installMcpOAuthCallbackBranding,
} from "./oauth-callback-branding.js"
import { migrateLegacyOAuthCredentials } from "./oauth-migration.js"
import { installOfflineAccessAuthorizationUrlTransform } from "./oauth-offline-access.js"
import { McpOAuthTurnContinuation } from "./oauth-turn-continuation.js"
import { MCP_PROJECT_TRUST_WARNING, resolveMcpProjectTrust } from "./project-trust.js"
import { collectReadOnlyMcpWireNames, isReadOnlyQualifiedMcpGatewayTool } from "./read-only.js"
import { cleanupStrayMcpOAuthEntriesBestEffort } from "./stray-oauth-entry-cleanup.js"

const MCP_PROXY_TOOL = "mcp"
const MCP_SCRIPT_TOOL = "mcpScript"
const MCP_SCRIPT_RECOMMENDATION = "When one request needs several MCP calls with logic between them, use mcpScript. "
const MCP_MANUAL_SETUP = "Add your servers to .mcp.json (project) or ~/.config/mcp/mcp.json (global), then run /reload."
const LAZY_GATEWAY_IDLE_TIMEOUT_MINUTES = 1
const LAZY_GATEWAY_REQUEST_TIMEOUT_MS = 10_000

function legacyMcpConfigWarning(cwd: string): string | undefined {
	const keys = getConfiguredLegacyMcpKeys({ cwd })
	if (keys.length === 0) return undefined
	return `Kimchi MCP config ${keys.join(", ")} no longer controls MCP behavior. The MCP adapter's weighted search and output guard are now authoritative; remove the obsolete key${keys.length === 1 ? "" : "s"}.`
}

interface McpToolSurfacePolicy {
	suppressedToolNames: Set<string>
}

function createMcpToolSurfacePolicy(config: McpConfig): McpToolSurfacePolicy {
	return {
		suppressedToolNames: new Set([
			MCP_SCRIPT_TOOL,
			...(Object.keys(config.mcpServers).length === 0 ? [MCP_PROXY_TOOL] : []),
		]),
	}
}

function isPlanningMode(pi: ExtensionAPI, ctx: ExtensionContext, parentSessionId?: string): boolean {
	const profile = getCurrentProfile(pi)
	const sessionId = parentSessionId ?? ctx.sessionManager.getSessionId()
	const permissionMode = getPermissionMode(sessionId)?.mode
	const explicitPlan = getParsedCliArgs().options.plan === true

	if (profile === "planning-ferment") return true
	if (permissionMode !== undefined) return permissionMode === "plan"

	// Before permission state is initialized, fall back to startup/profile
	// signals. Once initialized, the live mode is authoritative so stale plan
	// state cannot block MCP throughout the subsequent execution phase.
	return explicitPlan || profile === "planning-adhoc"
}

function blockedPlanningResult(toolName: string) {
	const reason =
		toolName === MCP_PROXY_TOOL
			? "This MCP gateway call is unavailable in plan mode. Use status, search, describe, instructions, server list, or a read-only-qualified tool call."
			: `MCP tool "${toolName}" is unavailable in plan mode.`
	return {
		content: [{ type: "text" as const, text: reason }],
		details: { error: "plan_mode_mcp_blocked", tool: toolName, message: reason },
		isError: true,
	}
}

/** The gateway stays visible for discovery and argument-checked reads; script and write-capable tools do not. */
function isHiddenFromPlanning(toolName: string, isReadOnlyTool: (wireName: string) => boolean): boolean {
	return toolName === MCP_SCRIPT_TOOL || (toolName !== MCP_PROXY_TOOL && !isReadOnlyTool(toolName))
}

const PLAN_SEARCH_KEYS = new Set(["search", "searchMode", "regex", "includeSchemas", "limit", "offset", "server"])

function hasOnlyKeys(params: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(params).every((key) => allowed.has(key))
}

function hasValidServer(params: Record<string, unknown>): boolean {
	return params.server === undefined || (typeof params.server === "string" && params.server.length > 0)
}

/** Positive allowlist for every adapter dispatch shape that is read-only in plan mode. */
function isAllowlistedGatewayCall(
	params: unknown,
	isReadOnlyGatewayTool: (toolName: string, server?: string) => boolean,
): boolean {
	if (typeof params !== "object" || params === null || Array.isArray(params)) return false
	const input = params as Record<string, unknown>
	const keys = Object.keys(input)
	if (keys.length === 0) return true
	if (keys.length === 1 && keys[0] === "instructions") return typeof input.instructions === "string"
	if (keys.length === 1 && keys[0] === "server") return hasValidServer(input)
	if (typeof input.describe === "string")
		return hasOnlyKeys(input, new Set(["describe", "server"])) && hasValidServer(input)
	if (typeof input.search === "string") return hasOnlyKeys(input, PLAN_SEARCH_KEYS) && hasValidServer(input)
	if (
		typeof input.tool === "string" &&
		input.tool.length > 0 &&
		hasOnlyKeys(input, new Set(["tool", "args", "server"]))
	) {
		return (
			hasValidServer(input) &&
			isReadOnlyGatewayTool(input.tool, typeof input.server === "string" ? input.server : undefined)
		)
	}
	return false
}

/** Planning never uses the file-attribution heuristic to authorize gateway state changes. */
function isBlockedInPlanning(
	toolName: string,
	params: unknown,
	getReadOnlyToolNames: (server?: string) => readonly string[],
	isReadOnlyGatewayTool: (toolName: string, server?: string) => boolean,
): boolean {
	if (toolName === MCP_SCRIPT_TOOL) return true
	if (toolName === MCP_PROXY_TOOL) return !isAllowlistedGatewayCall(params, isReadOnlyGatewayTool)
	return canChangeFiles(toolName, params, getReadOnlyToolNames, isReadOnlyGatewayTool)
}

/**
 * Whether a call can change local files. The gateway writes only through an action, such as an install, or a call of
 * a tool that is not read-only-qualified on the server it names; its search, describe and status calls only read.
 */
function canChangeFiles(
	toolName: string,
	params: unknown,
	getReadOnlyToolNames: (server?: string) => readonly string[],
	isReadOnlyGatewayTool: (toolName: string, server?: string) => boolean,
): boolean {
	if (toolName !== MCP_PROXY_TOOL) return !getReadOnlyToolNames().includes(toolName)
	// The adapter's schema makes these strings.
	const { action, tool, server } = params as { action?: string; tool?: string; server?: string }
	return action !== undefined || (tool !== undefined && !isReadOnlyGatewayTool(tool, server))
}

type UpstreamLifecycleHandler = ExtensionHandler<unknown, unknown>
type CapturedUpstreamEvent = "input" | "session_start"

/**
 * Registers the built-in gateway through the adapter's runtime-server API
 * instead of merging it into the adapter config: programmatic-config mode
 * downgrades /mcp and /mcp-auth from the overlay panel to plain text, while
 * runtime servers keep file-backed mode and get the same lifecycle
 * treatment as configured servers. Must be called after the adapter is
 * installed — the adapter answers on pi.events.
 */
function registerGatewayRuntimeServer(pi: ExtensionAPI, gateway: BuiltInGatewayServer): void {
	const request: McpRuntimeRegistrationRequest = {
		version: MCP_RUNTIME_REGISTER_VERSION,
		name: gateway.name,
		definition: gateway.entry,
	}
	pi.events.emit(MCP_RUNTIME_REGISTER_EVENT, request)
	if (request.result === undefined) {
		console.error(`MCP: gateway "${gateway.name}" runtime registration got no response from the adapter`)
		return
	}
	if (!request.result.ok) {
		const detail = request.result.error instanceof Error ? request.result.error.message : String(request.result.error)
		console.error(`MCP: gateway "${gateway.name}" runtime registration failed: ${detail}`)
	}
}

function createUpstreamApi(
	pi: ExtensionAPI,
	policy: McpToolSurfacePolicy,
	captureHandler: (event: CapturedUpstreamEvent, handler: UpstreamLifecycleHandler) => void,
	getReadOnlyToolNames: (server?: string) => readonly string[],
	isReadOnlyGatewayTool: (toolName: string, server?: string) => boolean,
	oauthTurnContinuation?: McpOAuthTurnContinuation,
	parentSessionId?: string,
): ExtensionAPI {
	const visibility = createToolVisibility(pi)
	const registeredToolNames = new Set<string>()
	const adapterActiveNames = new Set<string>()
	registerReadOnlyToolProvider(pi, () => {
		const readOnlyNames = new Set(getReadOnlyToolNames())
		return pi
			.getAllTools()
			.map(({ name }) => name)
			.filter(
				(name) =>
					registeredToolNames.has(name) && !isHiddenFromPlanning(name, (candidate) => readOnlyNames.has(candidate)),
			)
	})
	return new Proxy(pi, {
		get(target, property) {
			if (property === "on") {
				return (event: string, handler: (event: unknown, ctx: unknown) => unknown): void => {
					// Brand every adapter event path, not just slash-command handlers:
					// connect-/change-time notices (built-in MCP disable, sign-in
					// imports, network hints) notify through this ctx and previously
					// bypassed brandMcpAdapterText.
					const branded = (value: unknown, ctx: unknown) =>
						handler(value, createBrandedMcpContext(ctx as ExtensionContext))
					if (event === "session_start" || event === "input") {
						captureHandler(event, branded)
						return
					}
					const on = target.on as (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void
					on(event, branded)
				}
			}
			if (property === "registerTool") {
				return (tool: ToolDefinition): void => {
					if (policy.suppressedToolNames.has(tool.name)) return
					registeredToolNames.add(tool.name)
					adapterActiveNames.add(tool.name)
					const brandedTool = {
						...tool,
						description:
							tool.name === MCP_PROXY_TOOL
								? brandMcpAdapterText(tool.description.replace(MCP_SCRIPT_RECOMMENDATION, ""))
								: tool.description,
					}
					const execute = brandedTool.execute.bind(brandedTool)
					target.registerTool({
						...brandedTool,
						execute: async (...args: Parameters<typeof execute>) => {
							if (
								isPlanningMode(target, args[4], parentSessionId) &&
								isBlockedInPlanning(brandedTool.name, args[1], getReadOnlyToolNames, isReadOnlyGatewayTool)
							) {
								return blockedPlanningResult(brandedTool.name)
							}
							const run = () =>
								canChangeFiles(brandedTool.name, args[1], getReadOnlyToolNames, isReadOnlyGatewayTool)
									? observeToolFiles(args[4], args[0], "mcp", () => execute(...args))
									: execute(...args)
							const oauthServer =
								brandedTool.name === MCP_PROXY_TOOL
									? McpOAuthTurnContinuation.serverNameForAuthStart(args[1])
									: undefined
							const result =
								oauthTurnContinuation && oauthServer
									? await oauthTurnContinuation.runAuthStart(oauthServer, args[2], run)
									: await run()
							return brandMcpAdapterOwnedToolResult(result)
						},
					})
					visibility.enable([tool.name])
					reapplyCurrentProfile(target)
				}
			}
			if (property === "registerCommand") {
				return (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]): void => {
					// Kimchi exposes /mcp as its single adapter command: pi-mcp is the
					// legacy alias; mcp-adapter is the v5 canonical alias — identical
					// handler, but it would bypass the preset-setup guard below and
					// relaunch the alias drift this proxy exists to stop. Users who
					// bound `mcp.panel.open` keys get an unknown-command notice; the
					// panel still opens via /mcp.
					if (name === "pi-mcp" || name === "mcp-adapter") return
					const handler = command.handler
					const getArgumentCompletions = command.getArgumentCompletions
					target.registerCommand(name, {
						...command,
						...(name === "mcp" && getArgumentCompletions
							? {
									getArgumentCompletions: async (prefix: string) => {
										const items = (await getArgumentCompletions(prefix))?.filter((item) => item.value !== "setup")
										return items?.length ? items : null
									},
								}
							: {}),
						...(command.description === undefined || (name !== "mcp" && name !== "mcp-auth")
							? {}
							: { description: brandMcpAdapterText(command.description) }),
						handler: async (args, ctx) => {
							// Upstream's setup and empty-status panels offer built-in server
							// presets. Kimchi requires users to configure their own servers.
							if (name === "mcp") {
								const setup = args.trim().split(/\s+/)[0] === "setup"
								if (setup || policy.suppressedToolNames.has(MCP_PROXY_TOOL)) {
									const message = setup ? "Kimchi does not include MCP server presets." : "No MCP servers configured."
									ctx.ui.notify(`${message} ${MCP_MANUAL_SETUP}`, "info")
									return
								}
							}
							await handler(args, createBrandedMcpContext(ctx))
						},
					})
				}
			}
			if (property === "registerFlag") {
				return (name: string, flag: Parameters<ExtensionAPI["registerFlag"]>[1]): void => {
					if (name !== "mcp-config") target.registerFlag(name, flag)
				}
			}
			if (property === "sendMessage" && oauthTurnContinuation) {
				return (...args: Parameters<ExtensionAPI["sendMessage"]>): void => {
					if (oauthTurnContinuation.consumeStatusMessage(args[0])) return
					target.sendMessage(...args)
				}
			}
			if (property === "getActiveTools") {
				// The adapter reconciles removals against its own active surface.
				// A temporary planning profile must not hide that bookkeeping state.
				return (): string[] => [
					...new Set([
						...target.getActiveTools().filter((name) => !registeredToolNames.has(name)),
						...adapterActiveNames,
					]),
				]
			}
			if (property === "setActiveTools") {
				return (toolNames: string[]): void => {
					const allowedNames = toolNames.filter((name) => !policy.suppressedToolNames.has(name))
					const allowed = new Set(allowedNames)
					const profile = getCurrentProfile(target)
					const preserveGateway =
						getParsedCliArgs().options.plan === true || profile === "planning-adhoc" || profile === "planning-ferment"
					const removed: string[] = []
					adapterActiveNames.clear()
					for (const name of registeredToolNames) {
						if (allowed.has(name)) adapterActiveNames.add(name)
						// Omitting the admitted gateway from a planning snapshot must
						// not create a lasting vote; reconciliation removes other tools normally.
						else if (!preserveGateway || name !== MCP_PROXY_TOOL) removed.push(name)
					}
					// Persist only this adapter's votes so all later profile snapshots
					// respect removals, without changing other extensions' visibility.
					visibility.disable(removed)
					visibility.enable([...adapterActiveNames])
					if (!reapplyCurrentProfile(target)) applyCooperativeTweak(target, allowedNames)
				}
			}

			const value = Reflect.get(target, property, target)
			return typeof value === "function" ? value.bind(target) : value
		},
	})
}

export interface KimchiMcpAdapterExtensionOptions {
	cwd?: string
	callerServers?: Record<string, ServerEntry>
	/** Injected built-in gateway (tests); production builds it from resources + config. */
	builtinGateway?: BuiltInGatewayServer
	/**
	 * Drop warnings instead of surfacing them (UI notify / console fallback).
	 * Used by headless child sessions, where a console warning is stderr noise
	 * in the parent process.
	 */
	suppressWarnings?: boolean
	/**
	 * Connect the built-in gateway lazily (strip its keep-alive lifecycle so
	 * first use is cached metadata, reconnect on first tool call). Used by child
	 * sessions so every subagent spawn does not open an eager gateway connection.
	 */
	lazyGatewayConnect?: boolean
	/** Keep agent-started OAuth watchers inside their existing ACP tool/model run. */
	holdOAuthTurn?: boolean
	/** Main session whose live mode governs a subagent's MCP calls. */
	parentSessionId?: string
}

export function createKimchiMcpAdapterExtension(options: KimchiMcpAdapterExtensionOptions = {}): ExtensionFactory {
	return (pi) => installMcpAdapterExtension(pi, options)
}

function installMcpAdapterExtension(pi: ExtensionAPI, options: KimchiMcpAdapterExtensionOptions): void {
	// Kimchi gates project MCP configuration itself (resolveMcpProjectTrust);
	// the adapter's own interactive per-server approval would double-prompt.
	// The dependency patch honors this flag by standing that layer down.
	process.env.KIMCHI_MANAGES_MCP_PROJECT_TRUST = "1"
	installKeyringRequireBridge()
	cleanupStrayMcpOAuthEntriesBestEffort()
	installMcpOAuthCallbackBranding()
	pi.registerFlag("mcp-config", { description: "Path to MCP config file", type: "string" })
	let policy: McpToolSurfacePolicy | undefined
	const upstreamHandlers: Record<CapturedUpstreamEvent, UpstreamLifecycleHandler[]> = {
		input: [],
		session_start: [],
	}
	let warnings: string[] = []
	let sessionGeneration = 0
	const oauthTurnContinuation = options.holdOAuthTurn ? new McpOAuthTurnContinuation() : undefined
	// Only the adapter's current authenticated session may authorize private reads.
	let privateCatalogs = new Map<string, ServerCacheEntry>()

	// MCP status events arrive in bursts; one resnapshot after the burst settles
	// avoids re-deriving the active set (and re-setting the snapshot flag) on
	// every transition. Pending resnapshots are dropped on session boundaries:
	// after a replacement the captured pi is stale, and the new session's own
	// startup re-derives the set. registerTool stays synchronous — it is the
	// self-correction path for late registrations.
	const STATUS_RESYNC_DEBOUNCE_MS = 250
	let statusResyncTimer: ReturnType<typeof setTimeout> | undefined
	const clearStatusResync = (): void => {
		if (statusResyncTimer !== undefined) {
			clearTimeout(statusResyncTimer)
			statusResyncTimer = undefined
		}
	}

	// The adapter is installed after trust resolves, but its input readiness hook
	// must exist before extension event dispatch begins. Forward through this
	// eagerly registered handler so cold-cache direct tools are ready for the
	// first model request.
	pi.on("input", async (event, ctx) => {
		for (const handler of upstreamHandlers.input) await handler(event, ctx)
	})

	pi.on("session_start", async (event, ctx) => {
		sessionGeneration++
		privateCatalogs = new Map()
		// A replacement path (new/fork/switch/resume) just invalidated the old pi;
		// its pending resnapshot is obsolete.
		clearStatusResync()
		if (!policy) {
			const cliOptions = getParsedCliArgs().options
			const overridePath = cliOptions["mcp-config"]
			const cwd = options.cwd ?? ctx.cwd
			const projectResult = loadKimchiMcpConfig({ cwd, overridePath })
			const userResult = loadKimchiMcpConfig({ cwd, includeProjectSources: false })
			const explicitTrust =
				cliOptions["no-approve"] === true
					? false
					: cliOptions.approve === true || overridePath !== undefined
						? true
						: undefined
			const projectTrusted = await resolveMcpProjectTrust(ctx, {
				projectConfig: projectResult.config,
				userConfig: userResult.config,
				...(explicitTrust === undefined ? {} : { explicitTrust }),
			})
			const selectedResult = projectTrusted ? projectResult : userResult
			// The built-in gateway is a user-level server: registered after the
			// trust-based selection, so it is present in untrusted projects too.
			// A user-configured server wins over it — by gateway address, or by
			// holding the built-in's name at any address (the adapter refuses
			// runtime registration for name collisions as well).
			const gatewayServer = options.builtinGateway ?? buildBuiltinGatewayServer()
			// Children use startup metadata discovery without keep-alive; the
			// discovery connection closes, and first tool use reconnects.
			const adjustedGatewayServer =
				options.lazyGatewayConnect && gatewayServer !== undefined
					? {
							name: gatewayServer.name,
							entry: {
								...gatewayServer.entry,
								lifecycle: undefined,
								directTools: false,
								idleTimeout: gatewayServer.entry.idleTimeout ?? LAZY_GATEWAY_IDLE_TIMEOUT_MINUTES,
							},
						}
					: gatewayServer
			const gateway =
				adjustedGatewayServer === undefined ||
				selectedResult.config.mcpServers[adjustedGatewayServer.name] !== undefined ||
				options.callerServers?.[adjustedGatewayServer.name] !== undefined ||
				hasGatewayAddress(selectedResult.config, getGatewayAddresses())
					? undefined
					: adjustedGatewayServer
			const config = options.callerServers
				? {
						...selectedResult.config,
						mcpServers: { ...selectedResult.config.mcpServers, ...options.callerServers },
					}
				: selectedResult.config
			const { warnings: oauthWarnings } = migrateLegacyOAuthCredentials(config, { cwd })
			const legacyConfigWarning = legacyMcpConfigWarning(cwd)
			warnings = [
				...selectedResult.warnings,
				...oauthWarnings,
				...(legacyConfigWarning === undefined ? [] : [legacyConfigWarning]),
				...(projectTrusted ? [] : [MCP_PROJECT_TRUST_WARNING]),
			]
			// Count the gateway toward the tool-surface policy and plan-mode
			// read-only classification, or an otherwise-empty config would suppress
			// the proxy tool and strand the gateway's tools.
			const effectiveConfig =
				gateway !== undefined
					? {
							...config,
							mcpServers: { ...config.mcpServers, [gateway.name]: gateway.entry },
						}
					: config
			const installedPolicy = createMcpToolSurfacePolicy(effectiveConfig)
			policy = installedPolicy
			// Lazy children register for initial runtime discovery without changing
			// file-backed config, plugin paths, installs, or resume reloads.
			const discoverGatewayAtStartup = options.lazyGatewayConnect === true && gateway !== undefined
			const adapterOptions: McpAdapterOptions = {
				createSessionMetadataObserver: () => {
					const generation = sessionGeneration
					return (serverName: string, entry: ServerCacheEntry): void => {
						if (generation !== sessionGeneration) return
						if (entry.cacheScope === "private") privateCatalogs.set(serverName, entry)
						else privateCatalogs.delete(serverName)
					}
				},
				...(discoverGatewayAtStartup && gateway
					? {
							initialRuntimeServers: { [gateway.name]: gateway.entry },
							initialRuntimeDiscoveryTimeoutMs: gateway.entry.requestTimeoutMs ?? LAZY_GATEWAY_REQUEST_TIMEOUT_MS,
						}
					: {}),
				...(options.callerServers || selectedResult.useProgrammaticConfig
					? { config, defaultProtocolVersion: DEFAULT_MCP_PROTOCOL_VERSION }
					: // Default the adapter's global config to the Studio-shared file so
						// adapter write flows (compat imports, Jev settings, write-backs)
						// land where kimchi 1.14 and Studio read them. An explicit
						// `--mcp-config` keeps winning; the trust flow never sees this default.
						// `defaultProtocolVersion` opts unconfigured servers into era
						// negotiation (2026-07-28 with legacy fallback); explicit per-server
						// `protocolVersion` values in mcp.json always win.
						{
							configPath: selectedResult.configPath ?? getSharedMcpConfigPath(),
							defaultProtocolVersion: DEFAULT_MCP_PROTOCOL_VERSION,
						}),
			}
			// Offline-access request parameters for every OAuth authorize URL; stateless, see
			// oauth-offline-access.ts.
			installOfflineAccessAuthorizationUrlTransform()
			createMcpAdapter(adapterOptions)(
				createUpstreamApi(
					pi,
					installedPolicy,
					(upstreamEvent, handler) => {
						upstreamHandlers[upstreamEvent].push(handler)
					},
					(server) => collectReadOnlyMcpWireNames(effectiveConfig, server, privateCatalogs),
					(toolName, server) => isReadOnlyQualifiedMcpGatewayTool(effectiveConfig, toolName, server, privateCatalogs),
					oauthTurnContinuation,
					options.parentSessionId,
				),
			)
			if (gateway !== undefined && !discoverGatewayAtStartup) registerGatewayRuntimeServer(pi, gateway)
		}

		for (const warning of warnings) {
			if (options.suppressWarnings) continue
			notifyUser(ctx, warning, "warning")
		}
		for (const handler of upstreamHandlers.session_start) await handler(event, ctx)
	})

	pi.events.on(MCP_STATUS_EVENT, () => {
		if (statusResyncTimer !== undefined) clearTimeout(statusResyncTimer)
		statusResyncTimer = setTimeout(() => {
			statusResyncTimer = undefined
			debugToolSurface(() => "[tool-surface] mcp status burst settled; resnapshotting active profile")
			try {
				reapplyCurrentProfile(pi)
			} catch (error) {
				// The captured pi can be action-blocked when the timer fires: the
				// extension is still loading, or the session was replaced/reloaded
				// after the status event. Dropping is correct — the active session's
				// own startup re-derives the set. Anything else is a real error, but
				// rethrowing inside a timer callback would crash the process, so log it.
				if (isActionBlockedError(error)) {
					const message = error instanceof Error ? error.message : String(error)
					debugToolSurface(() => `[tool-surface] resnapshot dropped: ${message}`)
					return
				}
				console.error("[tool-surface] mcp status resnapshot failed:", error)
			}
		}, STATUS_RESYNC_DEBOUNCE_MS)
	})
	pi.on("session_shutdown", () => {
		clearStatusResync()
		sessionGeneration++
		privateCatalogs.clear()
		oauthTurnContinuation?.shutdown()
	})
}

export default function mcpAdapterExtension(pi: ExtensionAPI): void {
	installMcpAdapterExtension(pi, {})
}
