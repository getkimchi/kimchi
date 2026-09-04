import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { createMcpAdapter, MCP_STATUS_EVENT } from "pi-mcp-adapter"
import type { ServerEntry } from "pi-mcp-adapter/types"
import { getParsedCliArgs } from "../../cli-args.js"
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
import { migrateLegacyOAuthCredentials } from "./oauth-migration.js"

const MCP_PROXY_TOOL = "mcp"
const MCP_SCRIPT_TOOL = "mcpScript"
const MCP_DIRECT_TOOL_LABEL_PREFIX = "MCP: "

interface McpToolSurfacePolicy {
	annotationCatalog: McpAnnotationCatalog
	directTools: Map<string, { originalName: string; description: string }>
	suppressedToolNames: Set<string>
}

function createMcpToolSurfacePolicy(
	hasConfiguredServers: boolean,
	annotationCatalog: McpAnnotationCatalog,
): McpToolSurfacePolicy {
	return {
		annotationCatalog,
		directTools: new Map(),
		suppressedToolNames: new Set([MCP_SCRIPT_TOOL, ...(!hasConfiguredServers ? [MCP_PROXY_TOOL] : [])]),
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
	const gatewayTool = (params as { tool?: unknown }).tool
	if (typeof gatewayTool !== "string") return undefined
	return policy.annotationCatalog.isReadOnlyByName(gatewayTool) ? undefined : gatewayTool
}

function createUpstreamApi(pi: ExtensionAPI, policy: McpToolSurfacePolicy): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property) {
			if (property === "on") {
				return (event: string, handler: (event: unknown, ctx: unknown) => unknown): void => {
					const on = target.on as (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void
					on(event, (eventValue, ctx) =>
						runWithMcpAnnotationCatalog(policy.annotationCatalog, () => handler(eventValue, ctx)),
					)
				}
			}
			if (property === "registerTool") {
				return (tool: ToolDefinition): void => {
					if (policy.suppressedToolNames.has(tool.name)) return
					const originalName = getDirectToolOriginalName(tool)
					if (originalName) {
						policy.directTools.set(tool.name, { originalName, description: tool.description })
					}
					const execute = tool.execute.bind(tool)
					target.registerTool({
						...tool,
						execute: (...args: Parameters<typeof execute>) => {
							const blockedTool = blockedMcpToolInPlanning(target, policy, tool.name, originalName, args[1], args[4])
							if (blockedTool) return Promise.resolve(blockedPlanningResult(blockedTool))
							return runWithMcpAnnotationCatalog(policy.annotationCatalog, () => execute(...args))
						},
					})
					reapplyCurrentProfile(target)
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
	installMcpAnnotationCapture()
	const overridePath = getParsedCliArgs().options["mcp-config"]
	const {
		config: fileConfig,
		configPath,
		warnings: configWarnings,
	} = loadKimchiMcpConfig({
		cwd: options.cwd,
		overridePath,
	})
	const config = options.callerServers
		? { ...fileConfig, mcpServers: { ...fileConfig.mcpServers, ...options.callerServers } }
		: fileConfig
	const { warnings: oauthWarnings } = migrateLegacyOAuthCredentials(config)
	const warnings = [...configWarnings, ...oauthWarnings]
	const hasConfiguredServers = Object.keys(config.mcpServers).length > 0
	const annotationCatalog = new McpAnnotationCatalog({
		sourceHash: mcpAnnotationSourceHash(config),
		onChanged: () => reapplyCurrentProfile(pi),
	})
	const policy = createMcpToolSurfacePolicy(hasConfiguredServers, annotationCatalog)

	registerReadOnlyToolProvider(pi, () =>
		[...policy.directTools]
			.filter(([, tool]) => annotationCatalog.isReadOnly(tool.originalName, tool.description))
			.map(([toolName]) => toolName),
	)

	pi.on("session_start", (_event, ctx) => {
		for (const warning of warnings) {
			if (ctx.hasUI) ctx.ui.notify(warning, "warning")
			else console.warn(warning)
		}
	})

	pi.events.on(MCP_STATUS_EVENT, () => {
		reapplyCurrentProfile(pi)
	})

	const adapterOptions = options.callerServers ? { config } : configPath ? { configPath } : {}
	runWithMcpAnnotationCatalog(policy.annotationCatalog, () => {
		createMcpAdapter(adapterOptions)(createUpstreamApi(pi, policy))
	})
}

export default function mcpAdapterExtension(pi: ExtensionAPI): void {
	installMcpAdapterExtension(pi, {})
}
