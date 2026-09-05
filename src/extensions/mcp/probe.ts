import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	RegisteredCommand,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { createMcpAdapter } from "pi-mcp-adapter"
import { inspectMcpOAuthTokensForUrl } from "pi-mcp-adapter/oauth"
import type { ServerEntry } from "pi-mcp-adapter/types"
import { installKeyringRequireBridge } from "./keyring-require-bridge.js"

export interface ProbeTool {
	name: string
	title?: string
	description?: string
}

export interface ProbeResult {
	tools: ProbeTool[]
	needsAuth: boolean
	error: string | null
}

export interface McpProbeOptions {
	authenticate?: boolean
	cwd?: string
	signal?: AbortSignal
}

export interface McpProbe {
	probeTools(name: string, definition: ServerEntry, options?: McpProbeOptions): Promise<ProbeResult>
}

type Handler = ExtensionHandler<unknown, unknown>
type Command = Omit<RegisteredCommand, "name" | "sourceInfo">
type GatewayResult = Awaited<ReturnType<ToolDefinition["execute"]>>

interface ProbeHost {
	api: ExtensionAPI
	context: ExtensionContext
	commands: Map<string, Command>
	handlers: Map<string, Handler[]>
	tools: Map<string, ToolDefinition>
}

function executeProcess(
	command: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		const abort = () => child.kill()
		options.signal?.addEventListener("abort", abort, { once: true })
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk
		})
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk
		})
		child.once("error", (error) => {
			options.signal?.removeEventListener("abort", abort)
			resolve({ code: 1, stdout, stderr: stderr || error.message })
		})
		child.once("close", (code) => {
			options.signal?.removeEventListener("abort", abort)
			resolve({ code: code ?? 1, stdout, stderr })
		})
	})
}

function createProbeHost(cwd: string, signal: AbortSignal | undefined): ProbeHost {
	const handlers = new Map<string, Handler[]>()
	const commands = new Map<string, Command>()
	const tools = new Map<string, ToolDefinition>()
	const activeTools = new Set<string>()
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>()

	const ui = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
	}
	const context = { cwd, hasUI: true, mode: "tui", signal, ui } as unknown as ExtensionContext

	const api = {
		on(event: string, handler: Handler) {
			const current = handlers.get(event) ?? []
			current.push(handler)
			handlers.set(event, current)
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command)
		},
		registerFlag() {},
		getFlag() {
			return undefined
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool)
			activeTools.add(tool.name)
		},
		unregisterTool(name: string) {
			activeTools.delete(name)
			return tools.delete(name)
		},
		getActiveTools() {
			return [...activeTools]
		},
		getAllTools() {
			return [...tools.values()]
		},
		setActiveTools(names: string[]) {
			activeTools.clear()
			for (const name of names) activeTools.add(name)
		},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const current = eventHandlers.get(channel) ?? []
				current.push(handler)
				eventHandlers.set(channel, current)
				return () => {
					const index = current.indexOf(handler)
					if (index >= 0) current.splice(index, 1)
				}
			},
			emit(channel: string, data: unknown) {
				for (const handler of eventHandlers.get(channel) ?? []) handler(data)
			},
		},
		exec: executeProcess,
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerMarkdownTransformer() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI

	return { api, context, commands, handlers, tools }
}

function resultDetails(result: GatewayResult): Record<string, unknown> {
	return result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {}
}

function resultMessage(result: GatewayResult): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n")
}

function resolveProbeName(name: string, definition: ServerEntry): string {
	if (!definition.url) return name
	try {
		const status = inspectMcpOAuthTokensForUrl(name, definition.url) as { status: string }
		return status.status === "url-mismatch" ? `__probe_${randomUUID()}` : name
	} catch {
		return name
	}
}

async function emitHandlers(host: ProbeHost, event: "session_start" | "session_shutdown"): Promise<void> {
	const payload = event === "session_start" ? { type: event, reason: "startup" } : { type: event, reason: "shutdown" }
	for (const handler of host.handlers.get(event) ?? []) {
		await handler(payload, host.context)
	}
}

async function executeGateway(host: ProbeHost, params: Record<string, unknown>): Promise<GatewayResult> {
	const gateway = host.tools.get("mcp")
	if (!gateway) throw new Error("pi-mcp-adapter did not register its MCP gateway")
	return gateway.execute(`probe-${randomUUID()}`, params, host.context.signal, undefined, host.context)
}

export class UpstreamMcpProbe implements McpProbe {
	async probeTools(name: string, definition: ServerEntry, options: McpProbeOptions = {}): Promise<ProbeResult> {
		installKeyringRequireBridge()
		const cwd = options.cwd ?? process.cwd()
		const probeName = resolveProbeName(name, definition)
		const throwaway = probeName !== name
		const host = createProbeHost(cwd, options.signal)
		const config = {
			mcpServers: {
				[probeName]: { ...definition, directTools: false, lifecycle: "lazy" as const },
			},
			settings: {
				toolPrefix: "none" as const,
				directTools: false,
				scriptMode: false,
				autoAuth: options.authenticate === true,
				sampling: false,
				elicitation: false,
			},
		}
		try {
			createMcpAdapter({ config })(host.api)
			await emitHandlers(host, "session_start")
			const connected = await executeGateway(host, { connect: probeName })
			const details = resultDetails(connected)
			if (details.error === "auth_required") {
				return {
					tools: [],
					needsAuth: true,
					error: options.authenticate ? String(details.message ?? resultMessage(connected)) : null,
				}
			}
			if (details.error) {
				return { tools: [], needsAuth: false, error: String(details.message ?? resultMessage(connected)) }
			}

			const names = Array.isArray(details.tools)
				? details.tools.filter((toolName): toolName is string => typeof toolName === "string")
				: []
			const tools = await Promise.all(
				names.map(async (toolName): Promise<ProbeTool> => {
					const described = await executeGateway(host, { describe: toolName })
					const tool = resultDetails(described).tool
					const description =
						tool && typeof tool === "object" && typeof (tool as { description?: unknown }).description === "string"
							? (tool as { description: string }).description
							: undefined
					return { name: toolName, ...(description ? { description } : {}) }
				}),
			)
			return { tools, needsAuth: false, error: null }
		} finally {
			if (throwaway) {
				const commandContext = host.context as Parameters<Command["handler"]>[1]
				await host.commands
					.get("mcp")
					?.handler(`logout ${probeName}`, commandContext)
					.catch(() => {})
			}
			await emitHandlers(host, "session_shutdown").catch(() => {})
		}
	}
}
