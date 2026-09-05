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
import { registerReadOnlyToolProvider } from "../../shared/planning/read-only-tool-registry.js"
import {
	applyCooperativeTweak,
	getCurrentProfile,
	reapplyCurrentProfile,
} from "../../shared/planning/tool-profile-manager.js"
import { getPermissionMode } from "../permissions/mode-controller.js"
import {
	installMcpAnnotationCapture,
	McpAnnotationCatalog,
	mcpAnnotationSourceHash,
	runWithMcpAnnotationCatalog,
} from "./annotation-catalog.js"
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
const MCP_DIRECT_TOOL_LABEL_PREFIX = "MCP: "
const MCP_SCRIPT_RECOMMENDATION = "When one request needs several MCP calls with logic between them, use mcpScript. "

function legacyMcpConfigWarning(cwd: string): string | undefined {
	const keys = getConfiguredLegacyMcpKeys({ cwd })
	if (keys.length === 0) return undefined
	return `Kimchi MCP config ${keys.join(", ")} no longer controls MCP behavior. The MCP adapter's weighted search and output guard are now authoritative; remove the obsolete key${keys.length === 1 ? "" : "s"}.`
}

interface McpToolSurfacePolicy {
	annotationCatalog: McpAnnotationCatalog
	config: McpConfig
	directTools: Map<string, { originalName: string; description: string }>
	suppressedToolNames: Set<string>
}

function createMcpToolSurfacePolicy(config: McpConfig, annotationCatalog: McpAnnotationCatalog): McpToolSurfacePolicy {
	return {
		annotationCatalog,
		config,
		directTools: new Map(),
		suppressedToolNames: new Set([
			MCP_SCRIPT_TOOL,
			...(Object.keys(config.mcpServers).length === 0 ? [MCP_PROXY_TOOL] : []),
		]),
	}
}

function getDirectToolOriginalName(tool: ToolDefinition): string | undefined {
	if (tool.name === MCP_PROXY_TOOL || tool.name === MCP_SCRIPT_TOOL) return undefined
	if (!tool.label.startsWith(MCP_DIRECT_TOOL_LABEL_PREFIX)) return undefined
	const originalName = tool.label.slice(MCP_DIRECT_TOOL_LABEL_PREFIX.length).trim()
	return originalName || undefined
}

function planningBlockReason(originalName: string): string {
	return `MCP tool "${originalName}" is not read-only according to its protocol annotations and is unavailable in plan mode.`
}

function blockedPlanningResult(originalName: string) {
	const reason = planningBlockReason(originalName)
	return {
		content: [{ type: "text" as const, text: reason }],
		details: { error: "plan_mode_write_blocked", tool: originalName, message: reason },
		isError: true,
	}
}

function blockedMcpToolInPlanning(
	pi: ExtensionAPI,
	policy: McpToolSurfacePolicy,
	registeredName: string,
	originalName: string | undefined,
	params: unknown,
	ctx: ExtensionContext,
): string | undefined {
	const profile = getCurrentProfile(pi)
	const permissionMode = getPermissionMode(ctx.sessionManager.getSessionId())?.mode
	const explicitPlan = getParsedCliArgs().options.plan === true
	if (!explicitPlan && permissionMode !== "plan" && profile !== "planning-adhoc" && profile !== "planning-ferment")
		return undefined
	if (originalName)
		return policy.annotationCatalog.isReadOnly(originalName, policy.directTools.get(registeredName)?.description)
			? undefined
			: originalName
	if (registeredName !== MCP_PROXY_TOOL || !params || typeof params !== "object" || Array.isArray(params))
		return undefined
	const gatewayParams = params as { server?: unknown; tool?: unknown }
	const gatewayTool = gatewayParams.tool
	if (typeof gatewayTool !== "string") return undefined
	const gatewayServer = typeof gatewayParams.server === "string" ? gatewayParams.server : undefined
	return policy.annotationCatalog.isReadOnlyGatewayTool(gatewayTool, gatewayServer, policy.config)
		? undefined
		: gatewayTool
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
					const wrapped = (eventValue: unknown, ctx: unknown) =>
						runWithMcpAnnotationCatalog(policy.annotationCatalog, () => handler(eventValue, ctx))
					if (event === "session_start" || event === "input") {
						captureHandler(event, (eventValue, ctx) => wrapped(eventValue, ctx))
						return
					}
					const on = target.on as (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void
					on(event, wrapped)
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
					const originalName = getDirectToolOriginalName(brandedTool)
					if (originalName) {
						policy.directTools.set(brandedTool.name, { originalName, description: brandedTool.description })
					}
					const execute = brandedTool.execute.bind(brandedTool)
					target.registerTool({
						...brandedTool,
						execute: (...args: Parameters<typeof execute>) => {
							const blockedTool = blockedMcpToolInPlanning(
								target,
								policy,
								brandedTool.name,
								originalName,
								args[1],
								args[4],
							)
							if (blockedTool) return Promise.resolve(blockedPlanningResult(blockedTool))
							return runWithMcpAnnotationCatalog(policy.annotationCatalog, async () =>
								brandMcpAdapterOwnedToolResult(await execute(...args)),
							)
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
	installMcpAnnotationCapture()
	pi.registerFlag("mcp-config", { description: "Path to MCP config file", type: "string" })
	let policy: McpToolSurfacePolicy | undefined
	const upstreamHandlers: Record<CapturedUpstreamEvent, UpstreamLifecycleHandler[]> = {
		input: [],
		session_start: [],
	}
	let warnings: string[] = []

	registerReadOnlyToolProvider(pi, () => {
		const currentPolicy = policy
		if (!currentPolicy) return []
		return [...currentPolicy.directTools]
			.filter(([, tool]) => currentPolicy.annotationCatalog.isReadOnly(tool.originalName, tool.description))
			.map(([toolName]) => toolName)
	})

	// The adapter is installed after trust resolves, but its input readiness hook
	// must exist before extension event dispatch begins. Forward through this
	// eagerly registered handler so cold-cache direct tools and annotations are
	// ready for the first model request.
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
			const annotationCatalog = new McpAnnotationCatalog({
				sourceHash: mcpAnnotationSourceHash(config),
				onChanged: () => reapplyCurrentProfile(pi),
			})
			const installedPolicy = createMcpToolSurfacePolicy(config, annotationCatalog)
			policy = installedPolicy
			const adapterOptions: McpAdapterOptions =
				options.callerServers || selectedResult.useProgrammaticConfig
					? { config }
					: selectedResult.configPath
						? { configPath: selectedResult.configPath }
						: {}
			runWithMcpAnnotationCatalog(installedPolicy.annotationCatalog, () => {
				createMcpAdapter(adapterOptions)(
					createUpstreamApi(pi, installedPolicy, (upstreamEvent, handler) => {
						upstreamHandlers[upstreamEvent].push(handler)
					}),
				)
			})
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
