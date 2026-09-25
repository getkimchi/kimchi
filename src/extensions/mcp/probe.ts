import { AsyncLocalStorage } from "node:async_hooks"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	RegisteredCommand,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Client, type ListToolsResult } from "@modelcontextprotocol/client"
import { createMcpAdapter } from "pi-mcp-adapter"
import { inspectMcpOAuthTokensForUrl } from "pi-mcp-adapter/oauth"
import type { ServerEntry } from "pi-mcp-adapter/types"
import { inspectMcpCredentialAccount, installKeyringRequireBridge } from "./keyring-require-bridge.js"
import { migrateLegacyOAuthCredentials } from "./oauth-migration.js"

type SdkTool = ListToolsResult["tools"][number]

export type ProbeTool = Pick<SdkTool, "name"> &
	Partial<Pick<SdkTool, "title" | "description" | "inputSchema" | "annotations">>

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

const probeToolCapture = new AsyncLocalStorage<Map<string, ProbeTool>>()
let probeToolCaptureInstalled = false

/** Generous budget for an interactive browser OAuth consent inside a probe. */
const INTERACTIVE_AUTH_TIMEOUT_MS = 300_000

interface DeadlineControl {
	suspendDeadline: () => void
	resumeDeadline: () => void
}

function installProbeToolMetadataCapture(): void {
	if (probeToolCaptureInstalled) return
	probeToolCaptureInstalled = true
	const listTools = Client.prototype.listTools
	Client.prototype.listTools = async function (
		this: Client,
		...args: Parameters<Client["listTools"]>
	): ReturnType<Client["listTools"]> {
		const result = await listTools.apply(this, args)
		const capture = probeToolCapture.getStore()
		if (capture) {
			for (const tool of result.tools) capture.set(tool.name, tool)
		}
		return result
	}
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
		select: neverSettle,
		confirm: neverSettle,
		input: neverSettle,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Never settle: upstream's OAuth flow races the localhost callback against a
 * manual-paste prompt on `ui.input`; a resolving fake would win that race and
 * cancel the flow while the user is still on the consent page.
 */
function neverSettle(): Promise<never> {
	return new Promise(() => {})
}

function resultDetails(result: GatewayResult): Record<string, unknown> {
	return isRecord(result.details) ? result.details : {}
}

function resultMessage(result: GatewayResult): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n")
}

function hasOAuthCredentials(serverName: string, serverUrl: string): boolean {
	try {
		return inspectMcpOAuthTokensForUrl(serverName, serverUrl).status === "present"
	} catch {
		// Credential inspection is best-effort for OAuth detection; treat an
		// unreadable store as "no credentials" so declared-OAuth servers still
		// surface the auth requirement instead of a false "connected".
		return false
	}
}

function resolveProbeName(name: string, definition: ServerEntry): string {
	if (!definition.url) return name
	try {
		const urlStatus = inspectMcpOAuthTokensForUrl(name, definition.url)
		if (urlStatus.status === "present") return name
		if (urlStatus.status === "absent") {
			const account = inspectMcpCredentialAccount(name)
			if (account.status === "absent" || (account.status === "present" && !account.serverUrl)) return name
			if (account.status === "present" && account.serverUrl === definition.url) return name
		}
	} catch {
		// Credential inspection is best-effort, but credential preservation is
		// fail-closed: an unverified URL must never reuse the durable account name.
	}
	return `__probe_${randomUUID()}`
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
		options.signal?.throwIfAborted()
		installKeyringRequireBridge()
		installProbeToolMetadataCapture()
		const capturedTools = new Map<string, ProbeTool>()
		// URL-only servers can advertise OAuth during connection. Reserve time
		// for that discovery without assuming every remote server needs a login.
		const timeoutMs = definition.url ? 60_000 : 15_000
		const timeoutMessage = `Probe timed out after ${timeoutMs / 1000} seconds`
		const deadline = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
			() => deadline.abort(new Error(timeoutMessage)),
			timeoutMs,
		)
		// Interactive OAuth can legitimately outlast the probe deadline (the user
		// must find the browser and consent), so the auth phase suspends/resumes it.
		const suspendDeadline = (): void => {
			if (timer !== undefined) {
				clearTimeout(timer)
				timer = undefined
			}
		}
		const resumeDeadline = (): void => {
			if (timer === undefined && !deadline.signal.aborted) {
				timer = setTimeout(() => deadline.abort(new Error(timeoutMessage)), timeoutMs)
			}
		}
		const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
		try {
			return await probeToolCapture.run(capturedTools, () =>
				this.probeToolsWithMetadata(name, definition, { ...options, signal }, capturedTools, {
					suspendDeadline,
					resumeDeadline,
				}),
			)
		} catch (error) {
			if (deadline.signal.aborted && !options.signal?.aborted) {
				return { tools: [], needsAuth: false, error: timeoutMessage }
			}
			throw error
		} finally {
			suspendDeadline()
		}
	}

	private async probeToolsWithMetadata(
		name: string,
		definition: ServerEntry,
		options: McpProbeOptions & { signal: AbortSignal },
		capturedTools: Map<string, ProbeTool>,
		deadline: DeadlineControl,
	): Promise<ProbeResult> {
		const cwd = options.cwd ?? process.cwd()
		if (definition.url) {
			const { warnings } = migrateLegacyOAuthCredentials({ mcpServers: { [name]: definition } }, { cwd })
			for (const warning of warnings) console.warn(warning)
		}
		const probeName = resolveProbeName(name, definition)
		const throwaway = probeName !== name
		// Mirrors the adapter's supportsOAuth gate (pi-mcp-adapter/mcp-auth-flow.ts):
		// URL servers only (stdio cannot run the browser flow); an explicit
		// `oauth: false` or custom `headers` disables it despite `auth: "oauth"`.
		const serverUrl = definition.url
		const declaresOAuth =
			serverUrl !== undefined &&
			definition.oauth !== false &&
			!(definition.headers && Object.keys(definition.headers).length > 0) &&
			(definition.auth === "oauth" || Boolean(definition.oauth))
		const hasCredentials = serverUrl !== undefined && hasOAuthCredentials(name, serverUrl)
		const host = createProbeHost(cwd, options.signal)
		const config = {
			mcpServers: {
				[probeName]: { ...definition, directTools: false, lifecycle: "lazy" as const },
			},
			settings: {
				toolPrefix: "none" as const,
				directTools: false,
				scriptMode: false,
				// Upstream only starts OAuth after a needs-auth connection result
				// and its supportsOAuth check; public and bearer servers skip it.
				autoAuth: options.authenticate === true,
				sampling: false,
				elicitation: false,
			},
		}
		const { signal } = options
		let onAbort: () => void = () => {}
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(signal.reason)
			signal.addEventListener("abort", onAbort, { once: true })
		})
		try {
			signal.throwIfAborted()
			createMcpAdapter({ config })(host.api)
			await Promise.race([emitHandlers(host, "session_start"), aborted])
			signal.throwIfAborted()
			const connected = await Promise.race([executeGateway(host, { connect: probeName }), aborted])
			signal.throwIfAborted()
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

			// Anonymous tools/list (e.g. Google's hosted MCP endpoints) means a successful
			// connect doesn't imply auth: declared-OAuth servers without credentials must
			// report needs-auth, driving the TUI's /mcp-auth flow when authenticate=true.
			if (declaresOAuth && serverUrl && !hasCredentials) {
				// Never drive OAuth under a throwaway name — the finally-block logout
				// would discard the just-consented credentials.
				if (options.authenticate !== true || throwaway) {
					return { tools: [...capturedTools.values()], needsAuth: true, error: null }
				}
				// Credentials are keyed by server name, so authenticate under the probe's
				// name; the throwaway guard above keeps durable credentials safe.
				deadline.suspendDeadline()
				let authTimer: ReturnType<typeof setTimeout> | undefined
				let authFailureMessage: string | null = null
				const interactiveDeadline = new Promise<never>((_resolve, reject) => {
					authTimer = setTimeout(
						() =>
							reject(new Error(`OAuth authentication timed out after ${INTERACTIVE_AUTH_TIMEOUT_MS / 1000} seconds`)),
						INTERACTIVE_AUTH_TIMEOUT_MS,
					)
				})
				try {
					await Promise.race([
						host.commands.get("mcp-auth")?.handler(probeName, host.context as Parameters<Command["handler"]>[1]),
						interactiveDeadline,
						aborted,
					])
				} catch (authError) {
					signal.throwIfAborted()
					// Failures are re-detected via credential inspection below, but must not
					// stay silent: surface the reason on the result for diagnosis.
					authFailureMessage = authError instanceof Error ? authError.message : String(authError)
					console.warn(`MCP probe: interactive OAuth for "${probeName}" failed: ${authFailureMessage}`)
				} finally {
					clearTimeout(authTimer)
					deadline.resumeDeadline()
				}
				signal.throwIfAborted()
				if (!hasOAuthCredentials(probeName, serverUrl)) {
					return { tools: [], needsAuth: true, error: authFailureMessage }
				}
				const reconnected = await Promise.race([executeGateway(host, { connect: probeName }), aborted])
				signal.throwIfAborted()
				const reconnectDetails = resultDetails(reconnected)
				if (reconnectDetails.error === "auth_required") {
					return { tools: [], needsAuth: true, error: null }
				}
				if (reconnectDetails.error) {
					return {
						tools: [],
						needsAuth: false,
						error: String(reconnectDetails.message ?? resultMessage(reconnected)),
					}
				}
			}

			// The gateway catalog is filtered, renames tools, and adds resource tools.
			// Discovery must expose the server's original tools/list catalog so users
			// can select tools that their current model-facing configuration excludes.
			return { tools: [...capturedTools.values()], needsAuth: false, error: null }
		} finally {
			signal.removeEventListener("abort", onAbort)
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
