import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionHandler,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { createMcpAdapter, MCP_STATUS_EVENT } from "pi-mcp-adapter"
import type { McpAdapterOptions, McpConfig, ServerEntry } from "pi-mcp-adapter/types"
import { getParsedCliArgs } from "../../cli-args.js"
import { getConfiguredLegacyMcpKeys } from "../../config.js"
import {
	applyCooperativeTweak,
	getCurrentProfile,
	reapplyCurrentProfile,
} from "../../shared/planning/tool-profile-manager.js"
import { getPermissionMode } from "../permissions/mode-controller.js"
import { createToolVisibility } from "../prompt-construction/tool-visibility.js"
import { loadKimchiMcpConfig } from "./config.js"
import { installKeyringRequireBridge } from "./keyring-require-bridge.js"
import {
	brandMcpAdapterOwnedToolResult,
	brandMcpAdapterText,
	createBrandedMcpContext,
	installMcpOAuthCallbackBranding,
} from "./oauth-callback-branding.js"
import { migrateLegacyOAuthCredentials } from "./oauth-migration.js"
import { MCP_PROJECT_TRUST_WARNING, resolveMcpProjectTrust } from "./project-trust.js"

const MCP_PROXY_TOOL = "mcp"
const MCP_SCRIPT_TOOL = "mcpScript"
const MCP_SCRIPT_RECOMMENDATION = "When one request needs several MCP calls with logic between them, use mcpScript. "
const MCP_MANUAL_SETUP = "Add your servers to .mcp.json (project) or ~/.config/mcp/mcp.json (global), then run /reload."

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

function isPlanningMode(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
	const profile = getCurrentProfile(pi)
	const permissionMode = getPermissionMode(ctx.sessionManager.getSessionId())?.mode
	const explicitPlan = getParsedCliArgs().options.plan === true

	if (profile === "planning-ferment") return true
	if (permissionMode !== undefined) return permissionMode === "plan"

	// Before permission state is initialized, fall back to startup/profile
	// signals. Once initialized, the live mode is authoritative so stale plan
	// state cannot block MCP throughout the subsequent execution phase.
	return explicitPlan || profile === "planning-adhoc"
}

function blockedPlanningResult(toolName: string) {
	const reason = `MCP tool "${toolName}" is unavailable in plan mode.`
	return {
		content: [{ type: "text" as const, text: reason }],
		details: { error: "plan_mode_mcp_blocked", tool: toolName, message: reason },
		isError: true,
	}
}

type UpstreamLifecycleHandler = ExtensionHandler<unknown, unknown>
type CapturedUpstreamEvent = "input" | "session_start"

function createUpstreamApi(
	pi: ExtensionAPI,
	policy: McpToolSurfacePolicy,
	captureHandler: (event: CapturedUpstreamEvent, handler: UpstreamLifecycleHandler) => void,
): ExtensionAPI {
	const visibility = createToolVisibility(pi)
	const registeredToolNames = new Set<string>()
	const adapterActiveNames = new Set<string>()
	return new Proxy(pi, {
		get(target, property) {
			if (property === "on") {
				return (event: string, handler: (event: unknown, ctx: unknown) => unknown): void => {
					if (event === "session_start" || event === "input") {
						captureHandler(event, handler)
						return
					}
					const on = target.on as (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void
					on(event, handler)
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
							if (isPlanningMode(target, args[4])) return blockedPlanningResult(brandedTool.name)
							return brandMcpAdapterOwnedToolResult(await execute(...args))
						},
					})
					visibility.enable([tool.name])
					reapplyCurrentProfile(target)
				}
			}
			if (property === "registerCommand") {
				return (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]): void => {
					if (name === "pi-mcp") return
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
					const removed: string[] = []
					adapterActiveNames.clear()
					for (const name of registeredToolNames) {
						if (allowed.has(name)) adapterActiveNames.add(name)
						else removed.push(name)
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
}

export function createKimchiMcpAdapterExtension(options: KimchiMcpAdapterExtensionOptions = {}): ExtensionFactory {
	return (pi) => installMcpAdapterExtension(pi, options)
}

function installMcpAdapterExtension(pi: ExtensionAPI, options: KimchiMcpAdapterExtensionOptions): void {
	installKeyringRequireBridge()
	installMcpOAuthCallbackBranding()
	pi.registerFlag("mcp-config", { description: "Path to MCP config file", type: "string" })
	let policy: McpToolSurfacePolicy | undefined
	const upstreamHandlers: Record<CapturedUpstreamEvent, UpstreamLifecycleHandler[]> = {
		input: [],
		session_start: [],
	}
	let warnings: string[] = []

	// The adapter is installed after trust resolves, but its input readiness hook
	// must exist before extension event dispatch begins. Forward through this
	// eagerly registered handler so cold-cache direct tools are ready for the
	// first model request.
	pi.on("input", async (event, ctx) => {
		for (const handler of upstreamHandlers.input) await handler(event, ctx)
	})

	pi.on("session_start", async (event, ctx) => {
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
			const installedPolicy = createMcpToolSurfacePolicy(config)
			policy = installedPolicy
			const adapterOptions: McpAdapterOptions =
				options.callerServers || selectedResult.useProgrammaticConfig
					? { config }
					: selectedResult.configPath
						? { configPath: selectedResult.configPath }
						: {}
			createMcpAdapter(adapterOptions)(
				createUpstreamApi(pi, installedPolicy, (upstreamEvent, handler) => {
					upstreamHandlers[upstreamEvent].push(handler)
				}),
			)
		}

		for (const warning of warnings) {
			if (ctx.hasUI) ctx.ui.notify(warning, "warning")
			else console.warn(warning)
		}
		for (const handler of upstreamHandlers.session_start) await handler(event, ctx)
	})

	pi.events.on(MCP_STATUS_EVENT, () => {
		reapplyCurrentProfile(pi)
	})
}

export default function mcpAdapterExtension(pi: ExtensionAPI): void {
	installMcpAdapterExtension(pi, {})
}
