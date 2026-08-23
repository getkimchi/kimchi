import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"
import { logger } from "./logger.js"
import { supportsOAuth } from "./mcp-auth-flow.js"
import { McpOAuthProvider } from "./mcp-oauth-provider.js"
import { resolveNpxBinary } from "./npx-resolver.js"
import type {
	McpResource,
	McpTool,
	ProbeMcpTool,
	ProbeResult,
	ServerDefinition,
	ServerEntry,
	ServerStreamResultPatchNotification,
	Transport,
} from "./types.js"
import { serverStreamResultPatchNotificationSchema } from "./types.js"

interface ServerConnection {
	client: Client
	transport: Transport
	definition: ServerDefinition
	tools: McpTool[]
	resources: McpResource[]
	lastUsedAt: number
	inFlight: number
	status: "connected" | "closed" | "needs-auth"
}

type UiStreamListener = (serverName: string, notification: ServerStreamResultPatchNotification["params"]) => void

export class McpServerManager {
	private connections = new Map<string, ServerConnection>()
	private connectPromises = new Map<string, Promise<ServerConnection>>()
	private uiStreamListeners = new Map<string, UiStreamListener>()

	async connect(name: string, definition: ServerDefinition): Promise<ServerConnection> {
		// Dedupe concurrent connection attempts
		if (this.connectPromises.has(name)) {
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			return this.connectPromises.get(name)!
		}

		// Reuse existing connection if healthy
		const existing = this.connections.get(name)
		if (existing?.status === "connected") {
			existing.lastUsedAt = Date.now()
			return existing
		}

		const promise = this.createConnection(name, definition)
		this.connectPromises.set(name, promise)

		try {
			const connection = await promise
			this.connections.set(name, connection)
			return connection
		} finally {
			this.connectPromises.delete(name)
		}
	}

	/**
	 * Create the transport (stdio or HTTP) for a server definition. Shared by
	 * createConnection() and probeTools() so npx resolution, env interpolation,
	 * and OAuth/bearer setup live in exactly one place.
	 */
	private async createTransport(name: string, definition: ServerDefinition): Promise<Transport> {
		if (definition.command) {
			let command = definition.command
			let args = definition.args ?? []

			if (command === "npx" || command === "npm") {
				const resolved = await resolveNpxBinary(command, args)
				if (resolved) {
					command = resolved.isJs ? "node" : resolved.binPath
					args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs
					logger.debug(`${name} resolved to ${resolved.binPath} (skipping npm parent)`)
				}
			}

			return new StdioClientTransport({
				command,
				args,
				env: resolveEnv(definition.env),
				cwd: definition.cwd,
				stderr: definition.debug ? "inherit" : "ignore",
			})
		}
		if (definition.url) {
			return this.createHttpTransport(definition as ServerEntry & { url: string }, name)
		}
		throw new Error(`Server ${name} has no command or url`)
	}

	private async createConnection(name: string, definition: ServerDefinition): Promise<ServerConnection> {
		let client = new Client({ name: `pi-mcp-${name}`, version: "1.0.0" })
		let transport: Transport | undefined

		try {
			transport = await this.createTransport(name, definition)
			const { tools, resources } = await this.connectAndDiscover(client, transport, name)

			return {
				client,
				transport,
				definition,
				tools,
				resources,
				lastUsedAt: Date.now(),
				inFlight: 0,
				status: "connected",
			}
		} catch (error) {
			// Check for UnauthorizedError - server requires OAuth
			if (error instanceof UnauthorizedError && supportsOAuth(definition)) {
				await client.close().catch(() => {})
				await transport?.close().catch(() => {})

				if (!transport) throw error

				return this.buildNeedsAuthConnection(client, transport, definition)
			}

			// SSE fallback for HTTP servers: if StreamableHTTP connect fails with a
			// non-auth error, retry with the legacy SSE transport.
			if (definition.url && transport && !(error instanceof UnauthorizedError)) {
				await transport.close().catch(() => {})
				await client.close().catch(() => {})
				transport = this.createSseTransport(definition as ServerEntry & { url: string }, name)
				client = new Client({ name: `pi-mcp-${name}`, version: "1.0.0" })

				try {
					const { tools, resources } = await this.connectAndDiscover(client, transport, name)

					return {
						client,
						transport,
						definition,
						tools,
						resources,
						lastUsedAt: Date.now(),
						inFlight: 0,
						status: "connected",
					}
				} catch (sseError) {
					if (sseError instanceof UnauthorizedError && supportsOAuth(definition)) {
						await client.close().catch(() => {})
						await transport.close().catch(() => {})
						return this.buildNeedsAuthConnection(client, transport, definition)
					}
					await client.close().catch(() => {})
					await transport.close().catch(() => {})
					throw sseError
				}
			}

			await client.close().catch(() => {})
			await transport?.close().catch(() => {})
			throw error
		}
	}

	/**
	 * Connect a client to a transport and fetch tools + resources.
	 * Shared by createConnection() for both StreamableHTTP and SSE attempts.
	 */
	private async connectAndDiscover(
		client: Client,
		transport: Transport,
		name: string,
	): Promise<{ tools: McpTool[]; resources: McpResource[] }> {
		await client.connect(transport)
		this.attachAdapterNotificationHandlers(name, client)
		const [tools, resources] = await Promise.all([this.fetchAllTools(client), this.fetchAllResources(client)])
		return { tools, resources }
	}

	/**
	 * Build a ServerConnection in the needs-auth state.
	 */
	private buildNeedsAuthConnection(
		client: Client,
		transport: Transport,
		definition: ServerDefinition,
	): ServerConnection {
		return {
			client,
			transport,
			definition,
			tools: [],
			resources: [],
			lastUsedAt: Date.now(),
			inFlight: 0,
			status: "needs-auth",
		}
	}

	/**
	 * Build the shared HTTP transport config (URL, headers, auth provider)
	 * used by both StreamableHTTP and SSE transports.
	 */
	private buildHttpConfig(
		definition: ServerDefinition & { url: string },
		serverName: string,
	): { url: URL; requestInit: Record<string, unknown> | undefined; authProvider: McpOAuthProvider | undefined } {
		const url = new URL(definition.url)

		// Build headers first (including any bearer token)
		const headers = resolveHeaders(definition.headers) ?? {}

		// For bearer auth, add the token to headers BEFORE creating requestInit
		if (definition.auth === "bearer") {
			const token =
				definition.bearerToken ?? (definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined)
			if (token) {
				headers.Authorization = `Bearer ${token}`
			}
		}

		// Create request init with headers (Authorization now included for bearer auth)
		const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined

		// For OAuth servers, create an auth provider
		let authProvider: McpOAuthProvider | undefined
		if (supportsOAuth(definition)) {
			const oauthConfig =
				definition.oauth === false
					? {}
					: {
							grantType: definition.oauth?.grantType,
							clientId: definition.oauth?.clientId,
							clientSecret: definition.oauth?.clientSecret,
							scope: definition.oauth?.scope,
						}
			authProvider = new McpOAuthProvider(serverName, definition.url, oauthConfig, {
				onRedirect: async (_authUrl) => {
					// URL is captured by startAuth, no need to log
				},
			})
		}

		return { url, requestInit, authProvider }
	}

	private createHttpTransport(definition: ServerDefinition & { url: string }, serverName: string): Transport {
		const { url, requestInit, authProvider } = this.buildHttpConfig(definition, serverName)
		return new StreamableHTTPClientTransport(url, { requestInit, authProvider })
	}

	/**
	 * Create an SSE transport for HTTP servers that don't support StreamableHTTP.
	 * Shares the same config (URL, headers, auth provider) as the StreamableHTTP transport.
	 */
	private createSseTransport(definition: ServerDefinition & { url: string }, serverName: string): Transport {
		const { url, requestInit, authProvider } = this.buildHttpConfig(definition, serverName)
		return new SSEClientTransport(url, { requestInit, authProvider })
	}

	private async fetchAllTools(client: Client): Promise<McpTool[]> {
		const allTools: McpTool[] = []
		let cursor: string | undefined

		do {
			const result = await client.listTools(cursor ? { cursor } : undefined)
			allTools.push(...(result.tools ?? []))
			cursor = result.nextCursor
		} while (cursor)

		return allTools
	}

	private async fetchAllResources(client: Client): Promise<McpResource[]> {
		try {
			const allResources: McpResource[] = []
			let cursor: string | undefined

			do {
				const result = await client.listResources(cursor ? { cursor } : undefined)
				allResources.push(...(result.resources ?? []))
				cursor = result.nextCursor
			} while (cursor)

			return allResources
		} catch {
			// Server may not support resources
			return []
		}
	}

	private attachAdapterNotificationHandlers(serverName: string, client: Client): void {
		client.setNotificationHandler(serverStreamResultPatchNotificationSchema, (notification) => {
			const listener = this.uiStreamListeners.get(notification.params.streamToken)
			if (!listener) return
			listener(serverName, notification.params)
		})
	}

	registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
		this.uiStreamListeners.set(streamToken, listener)
	}

	removeUiStreamListener(streamToken: string): void {
		this.uiStreamListeners.delete(streamToken)
	}

	async readResource(name: string, uri: string): Promise<ReadResourceResult> {
		const connection = this.connections.get(name)
		if (connection?.status !== "connected") {
			throw new Error(`Server "${name}" is not connected`)
		}

		try {
			this.touch(name)
			this.incrementInFlight(name)
			return await connection.client.readResource({ uri })
		} finally {
			this.decrementInFlight(name)
			this.touch(name)
		}
	}

	async close(name: string): Promise<void> {
		const connection = this.connections.get(name)
		if (!connection) return

		// Delete from map BEFORE async cleanup to prevent a race where a
		// concurrent connect() creates a new connection that our deferred
		// delete() would then remove, orphaning the new server process.
		connection.status = "closed"
		this.connections.delete(name)
		await connection.client.close().catch(() => {})
		await connection.transport.close().catch(() => {})
	}

	async closeAll(): Promise<void> {
		const names = [...this.connections.keys()]
		await Promise.all(names.map((name) => this.close(name)))
	}

	getConnection(name: string): ServerConnection | undefined {
		return this.connections.get(name)
	}

	getAllConnections(): Map<string, ServerConnection> {
		return new Map(this.connections)
	}

	touch(name: string): void {
		const connection = this.connections.get(name)
		if (connection) {
			connection.lastUsedAt = Date.now()
		}
	}

	incrementInFlight(name: string): void {
		const connection = this.connections.get(name)
		if (connection) {
			connection.inFlight = (connection.inFlight ?? 0) + 1
		}
	}

	decrementInFlight(name: string): void {
		const connection = this.connections.get(name)
		if (connection?.inFlight) {
			connection.inFlight--
		}
	}

	isIdle(name: string, timeoutMs: number): boolean {
		const connection = this.connections.get(name)
		if (connection?.status !== "connected") return false
		if (connection.inFlight > 0) return false
		return Date.now() - connection.lastUsedAt > timeoutMs
	}

	/**
	 * Probe an MCP server for available tools without persisting a connection.
	 *
	 * Creates a transient connection via the shared createTransport() helper,
	 * calls tools/list, handles OAuth flow if needed, closes the connection, and
	 * returns the tool list.
	 *
	 * - OAuth servers: 60s timeout (allows browser-based auth flow)
	 * - Non-OAuth servers: 15s timeout
	 *
	 * The transient connection is never registered in `this.connections`, so it
	 * doesn't interfere with the normal connection lifecycle. Both client and
	 * transport are closed in a finally block regardless of outcome.
	 */
	async probeTools(name: string, definition: ServerDefinition): Promise<ProbeResult> {
		const isOAuth = supportsOAuth(definition)
		const totalBudgetMs = isOAuth ? 60_000 : 15_000
		// Single deadline for the entire probe operation (connect + tools/list),
		// not per-operation, so an OAuth probe can't run 120s (60s connect + 60s
		// tools/list) — it gets a single 60s budget from start to finish.
		const deadline = Date.now() + totalBudgetMs

		let client = new Client({ name: `pi-mcp-probe-${name}`, version: "1.0.0" })
		let transport: Transport | undefined

		try {
			transport = await this.createTransport(name, definition)
		} catch (error) {
			if (error instanceof UnauthorizedError) return this.authProbeResult()
			return this.errorProbeResult(error)
		}

		try {
			const result = await this.connectAndList(client, transport, name, deadline)
			return result
		} catch (error) {
			// SSE fallback for HTTP servers: if StreamableHTTP connect fails with a
			// non-auth error, retry with the legacy SSE transport.
			if (definition.url && !(error instanceof UnauthorizedError)) {
				await transport.close().catch(() => {})
				await client.close().catch(() => {})
				transport = this.createSseTransport(definition as ServerEntry & { url: string }, name)
				client = new Client({ name: `pi-mcp-probe-${name}`, version: "1.0.0" })

				try {
					const result = await this.connectAndList(client, transport, name, deadline)
					return result
				} catch (sseError) {
					if (sseError instanceof UnauthorizedError) return this.authProbeResult()
					return this.errorProbeResult(sseError)
				}
			}

			if (error instanceof UnauthorizedError) return this.authProbeResult()
			return this.errorProbeResult(error)
		} finally {
			await client.close().catch(() => {})
			await transport?.close().catch(() => {})
		}
	}

	/**
	 * Connect a client to a transport, fetch tools, and return a ProbeResult.
	 * Shared by probeTools() for both StreamableHTTP and SSE attempts.
	 */
	private async connectAndList(
		client: Client,
		transport: Transport,
		name: string,
		deadline: number,
	): Promise<ProbeResult> {
		await withTimeout(client.connect(transport), deadline)
		this.attachAdapterNotificationHandlers(name, client)

		const tools = await withTimeout(this.fetchAllTools(client), deadline)
		const probeTools: ProbeMcpTool[] = tools.map((t) => ({
			name: t.name,
			title: t.title,
			description: t.description,
			inputSchema: t.inputSchema,
			annotations: t.annotations,
		}))

		return { tools: probeTools, needsAuth: false, error: null }
	}

	/**
	 * Build a ProbeResult indicating the server requires authentication.
	 */
	private authProbeResult(): ProbeResult {
		return { tools: [], needsAuth: true, error: null }
	}

	/**
	 * Build a ProbeResult from an error, extracting a human-readable message.
	 */
	private errorProbeResult(error: unknown): ProbeResult {
		return {
			tools: [],
			needsAuth: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

/**
 * Wrap a promise with a timeout. The `deadline` parameter is an absolute
 * timestamp (Date.now() + budgetMs). Rejects with an Error if the promise
 * doesn't settle before the deadline.
 *
 * The losing side of Promise.race is caught to prevent unhandled rejection
 * warnings if the original promise rejects after the timeout fires.
 */
async function withTimeout<T>(promise: Promise<T>, deadline: number): Promise<T> {
	const remaining = Math.max(0, deadline - Date.now())
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Operation timed out after ${remaining}ms`)), remaining)
			timer.unref?.()
		})
		// Prevent unhandled rejection if the original promise rejects after
		// the timeout wins the race.
		promise.catch(() => {})
		return await Promise.race([promise, timeout])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

/**
 * Resolve environment variables with interpolation.
 */
function resolveEnv(env?: Record<string, string>): Record<string, string> {
	// Copy process.env, filtering out undefined values
	const resolved: Record<string, string> = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			resolved[key] = value
		}
	}

	if (!env) return resolved

	for (const [key, value] of Object.entries(env)) {
		// Support ${VAR} and $env:VAR interpolation
		resolved[key] = value
			.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
			.replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "")
	}

	return resolved
}

/**
 * Resolve headers with environment variable interpolation.
 */
function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
	if (!headers) return undefined

	const resolved: Record<string, string> = {}
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = value
			.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
			.replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "")
	}
	return resolved
}
