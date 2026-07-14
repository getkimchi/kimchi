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

	private async createConnection(name: string, definition: ServerDefinition): Promise<ServerConnection> {
		const client = new Client({ name: `pi-mcp-${name}`, version: "1.0.0" })

		let transport: Transport

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

			transport = new StdioClientTransport({
				command,
				args,
				env: resolveEnv(definition.env),
				cwd: definition.cwd,
				stderr: definition.debug ? "inherit" : "ignore",
			})
		} else if (definition.url) {
			// HTTP transport with fallback
			transport = await this.createHttpTransport(definition as ServerEntry & { url: string }, name)
		} else {
			throw new Error(`Server ${name} has no command or url`)
		}

		try {
			await client.connect(transport)
			this.attachAdapterNotificationHandlers(name, client)

			// Discover tools and resources
			const [tools, resources] = await Promise.all([this.fetchAllTools(client), this.fetchAllResources(client)])

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
				// Clean up both client and transport before reporting needs-auth.
				await client.close().catch(() => {})
				await transport.close().catch(() => {})

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

			// Clean up both client and transport on any error
			await client.close().catch(() => {})
			await transport.close().catch(() => {})
			throw error
		}
	}

	private async createHttpTransport(
		definition: ServerDefinition & { url: string },
		serverName: string,
	): Promise<Transport> {
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
			// Extract OAuth config (handles both object and false cases)
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

		// Try StreamableHTTP first (modern MCP servers)
		const streamableTransport = new StreamableHTTPClientTransport(url, {
			requestInit,
			authProvider,
		})

		try {
			// Create a test client to verify the transport works
			const testClient = new Client({ name: "pi-mcp-probe", version: "2.1.2" })
			await testClient.connect(streamableTransport)
			await testClient.close().catch(() => {})
			// Close probe transport before creating fresh one
			await streamableTransport.close().catch(() => {})

			// StreamableHTTP works - create fresh transport for actual use
			return new StreamableHTTPClientTransport(url, { requestInit, authProvider })
		} catch (error) {
			// StreamableHTTP failed, close and try SSE fallback
			await streamableTransport.close().catch(() => {})

			// If this was an UnauthorizedError, don't try SSE - the server needs auth
			if (error instanceof UnauthorizedError) {
				throw error
			}

			// SSE is the legacy transport
			return new SSEClientTransport(url, { requestInit, authProvider })
		}
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
