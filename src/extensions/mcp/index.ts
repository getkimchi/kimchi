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
	return explicitPlan || permissionMode === "plan" || profile === "planning-adhoc" || profile === "planning-ferment"
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
					reapplyCurrentProfile(target)
				}
			}
			if (property === "registerCommand") {
				return (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]): void => {
					if (name === "pi-mcp") return
					const handler = command.handler
					target.registerCommand(name, {
						...command,
						...(command.description === undefined || (name !== "mcp" && name !== "mcp-auth")
							? {}
							: { description: brandMcpAdapterText(command.description) }),
						handler: (args, ctx) => handler(args, createBrandedMcpContext(ctx)),
					})
				}
			}
			if (property === "registerFlag") {
				return (name: string, flag: Parameters<ExtensionAPI["registerFlag"]>[1]): void => {
					if (name !== "mcp-config") target.registerFlag(name, flag)
				}
			}
			if (property === "setActiveTools") {
				return (toolNames: string[]): void => {
					const allowedNames = toolNames.filter((name) => !policy.suppressedToolNames.has(name))
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
