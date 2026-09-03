import { createHash, randomUUID } from "node:crypto"
import { appendFileSync } from "node:fs"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { isDeepStrictEqual } from "node:util"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
	CallToolRequestSchema,
	isInitializeRequest,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

const eventPath = process.env.KIMCHI_MCP_FIXTURE_EVENTS
const scenario = process.env.KIMCHI_MCP_FIXTURE_SCENARIO ?? "basic"
const transportKind = process.env.KIMCHI_MCP_FIXTURE_TRANSPORT ?? "stdio"
const expectedBearerToken = process.env.KIMCHI_MCP_FIXTURE_BEARER_TOKEN
const oauthEnabled = process.env.KIMCHI_MCP_FIXTURE_OAUTH === "1"
const oauthGrantType = process.env.KIMCHI_MCP_FIXTURE_OAUTH_GRANT_TYPE ?? "authorization_code"
const oauthClientId = process.env.KIMCHI_MCP_FIXTURE_OAUTH_CLIENT_ID ?? "kimchi-e2e-client"
const oauthClientSecret = process.env.KIMCHI_MCP_FIXTURE_OAUTH_CLIENT_SECRET ?? "kimchi-e2e-client-secret"
const oauthAccessToken = "kimchi-e2e-oauth-access-token"
const oauthRefreshToken = "kimchi-e2e-oauth-refresh-token"
const fixtureBehavior = process.env.KIMCHI_MCP_FIXTURE_BEHAVIOR
	? JSON.parse(process.env.KIMCHI_MCP_FIXTURE_BEHAVIOR)
	: {}

function findToolBehavior(name, args) {
	return fixtureBehavior.tools?.find(
		(behavior) =>
			behavior.name === name && (behavior.arguments === undefined || isDeepStrictEqual(behavior.arguments, args ?? {})),
	)
}

function record(type, details = {}) {
	if (!eventPath) return
	appendFileSync(
		eventPath,
		`${JSON.stringify({ type, at: new Date().toISOString(), pid: process.pid, scenario, ...details })}\n`,
		"utf-8",
	)
}

function createFixtureServer() {
	const server = new Server(
		{ name: "kimchi-mcp-e2e-fixture", version: "1.0.0" },
		{ capabilities: { tools: {}, resources: {} } },
	)

	server.oninitialized = () => record("initialized")

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		record("tools_listed")
		const uiTools =
			scenario === "ui-app"
				? [
						{
							name: "open_ui",
							description: "Open the deterministic Kimchi MCP App fixture",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
							_meta: { ui: { resourceUri: "ui://fixture/app" } },
						},
					]
				: []
		return {
			tools: [
				{
					name: "echo",
					description: "Echo deterministic text for Kimchi MCP end-to-end tests",
					inputSchema: {
						type: "object",
						properties: {
							message: { type: "string", description: "Text returned by the fixture" },
						},
						required: ["message"],
						additionalProperties: false,
					},
					annotations: { readOnlyHint: true },
				},
				{
					name: "fail",
					description: "Return a deterministic MCP tool error for Kimchi end-to-end tests",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
				},
				{
					name: "mixed_content",
					description: "Return deterministic text, image, and structured MCP content",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
					annotations: { readOnlyHint: true },
				},
				{
					name: "disconnect",
					description: "Exit the stdio fixture during a tool call",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
				},
				{
					name: "slow",
					description: "Wait for cancellation or a bounded delay",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
				},
				...uiTools,
			],
		}
	})

	server.setRequestHandler(ListResourcesRequestSchema, async () => {
		record("resources_listed")
		const uiResources =
			scenario === "ui-app"
				? [
						{
							name: "fixture app",
							uri: "ui://fixture/app",
							description: "Deterministic MCP App for Kimchi end-to-end tests",
							mimeType: "text/html;profile=mcp-app",
						},
					]
				: []
		return {
			resources: [
				{
					name: "fixture note",
					uri: "fixture://note",
					description: "Deterministic MCP resource for Kimchi end-to-end tests",
					mimeType: "text/plain",
				},
				...uiResources,
			],
		}
	})

	server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
		const { uri } = request.params
		record("resource_read", { uri })
		const configured = fixtureBehavior.resources?.find((behavior) => behavior.uri === uri)
		if (configured) return configured.response
		throw new Error(`No MCP fixture resource response configured for ${uri}`)
	})

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const { name, arguments: args } = request.params
		record("tool_called", { name, arguments: args ?? {} })
		const behavior = findToolBehavior(name, args)

		if (behavior?.response.type === "result") return behavior.response.value

		if (behavior?.response.type === "exit") {
			record("disconnect_started")
			setTimeout(() => process.exit(behavior.response.code), 0)
			return new Promise(() => {})
		}

		if (behavior?.response.type === "delayed-result") {
			record("slow_call_started")
			let onAbort
			const aborted = new Promise((_, reject) => {
				onAbort = () => {
					record("slow_call_cancelled")
					reject(new Error("fixture slow call cancelled"))
				}
				extra.signal.addEventListener("abort", onAbort, { once: true })
			})
			try {
				await Promise.race([delay(behavior.response.delayMs), aborted])
				record("slow_call_completed")
				return behavior.response.value
			} finally {
				if (onAbort) extra.signal.removeEventListener("abort", onAbort)
			}
		}

		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `No MCP fixture response configured for ${name} with arguments ${JSON.stringify(args ?? {})}`,
				},
			],
		}
	})

	return server
}

async function readBody(request) {
	const chunks = []
	for await (const chunk of request) chunks.push(chunk)
	return Buffer.concat(chunks).toString("utf-8")
}

async function readJsonBody(request) {
	const body = await readBody(request)
	if (!body) return undefined
	return JSON.parse(body)
}

function sendJson(response, statusCode, body) {
	response.writeHead(statusCode, { "content-type": "application/json" })
	response.end(JSON.stringify(body))
}

async function runHttpFixture() {
	const sessions = new Map()
	const authorizationCodes = new Map()
	let oauthAccessTokenExpiresAt = 0
	let origin = ""
	const httpServer = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://fixture.invalid")
			if (scenario === "http-malformed" && url.pathname === "/mcp") {
				record("http_malformed_response", { method: request.method })
				response.writeHead(200, { "content-type": "application/json" })
				response.end("{not-valid-json")
				return
			}

			if (transportKind === "sse" && url.pathname === "/sse") {
				if (request.method !== "GET") {
					record("sse_streamable_rejected", { method: request.method })
					response.writeHead(405)
					response.end("SSE endpoint requires GET")
					return
				}
				const server = createFixtureServer()
				const transport = new SSEServerTransport("/messages", response)
				sessions.set(transport.sessionId, { server, transport })
				transport.onclose = () => {
					sessions.delete(transport.sessionId)
					record("sse_session_closed", { sessionId: transport.sessionId })
				}
				record("sse_session_initialized", { sessionId: transport.sessionId })
				await server.connect(transport)
				return
			}

			if (transportKind === "sse" && request.method === "POST" && url.pathname === "/messages") {
				const activeSession = sessions.get(url.searchParams.get("sessionId"))
				if (!activeSession) {
					sendJson(response, 404, { error: "SSE session not found" })
					return
				}
				record("sse_message", { sessionId: url.searchParams.get("sessionId") })
				await activeSession.transport.handlePostMessage(request, response, await readJsonBody(request))
				return
			}

			if (oauthEnabled && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
				record("oauth_resource_metadata_requested", { path: url.pathname })
				sendJson(response, 200, {
					resource: `${origin}/mcp`,
					authorization_servers: [origin],
					scopes_supported: ["mcp:tools"],
				})
				return
			}

			if (oauthEnabled && url.pathname === "/.well-known/oauth-authorization-server") {
				record("oauth_server_metadata_requested")
				sendJson(response, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					grant_types_supported:
						oauthGrantType === "client_credentials" ? ["client_credentials"] : ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported:
						oauthGrantType === "client_credentials" ? ["client_secret_post"] : ["none"],
					scopes_supported: ["mcp:tools"],
				})
				return
			}

			if (oauthEnabled && request.method === "POST" && url.pathname === "/register") {
				const metadata = await readJsonBody(request)
				record("oauth_client_registered", { redirectUris: metadata?.redirect_uris })
				sendJson(response, 201, {
					...metadata,
					client_id: "kimchi-e2e-oauth-client",
					client_id_issued_at: Math.floor(Date.now() / 1000),
				})
				return
			}

			if (oauthEnabled && request.method === "GET" && url.pathname === "/authorize") {
				const redirectUri = url.searchParams.get("redirect_uri")
				const state = url.searchParams.get("state")
				const codeChallenge = url.searchParams.get("code_challenge")
				const codeChallengeMethod = url.searchParams.get("code_challenge_method")
				if (!redirectUri || !state || !codeChallenge || codeChallengeMethod !== "S256") {
					sendJson(response, 400, { error: "invalid_request" })
					return
				}
				if (scenario === "oauth-deny") {
					record("oauth_authorization_denied", { redirectUri })
					const callback = new URL(redirectUri)
					callback.searchParams.set("error", "access_denied")
					callback.searchParams.set("error_description", "fixture authorization denied")
					callback.searchParams.set("state", state)
					response.writeHead(302, { location: callback.toString() })
					response.end()
					return
				}
				const code = `kimchi-e2e-code-${randomUUID()}`
				authorizationCodes.set(code, {
					clientId: url.searchParams.get("client_id"),
					codeChallenge,
					redirectUri,
				})
				record("oauth_authorized", { redirectUri, state, codeChallengeMethod })
				const callback = new URL(redirectUri)
				callback.searchParams.set("code", code)
				callback.searchParams.set("state", state)
				response.writeHead(302, { location: callback.toString() })
				response.end()
				return
			}

			if (oauthEnabled && request.method === "POST" && url.pathname === "/token") {
				const params = new URLSearchParams(await readBody(request))
				const grantType = params.get("grant_type")
				if (scenario === "oauth-token-failure") {
					record("oauth_token_rejected", { grantType })
					sendJson(response, 400, { error: "invalid_grant", error_description: "fixture token rejection" })
					return
				}
				if (grantType === "client_credentials") {
					const credentialsValid =
						params.get("client_id") === oauthClientId && params.get("client_secret") === oauthClientSecret
					if (!credentialsValid) {
						record("oauth_token_rejected", { grantType })
						sendJson(response, 401, { error: "invalid_client" })
						return
					}
					record("oauth_token_issued", { grantType, expiresIn: 3600 })
					oauthAccessTokenExpiresAt = Date.now() + 3_600_000
					sendJson(response, 200, {
						access_token: oauthAccessToken,
						token_type: "Bearer",
						expires_in: 3600,
						scope: params.get("scope") ?? "mcp:tools",
					})
					return
				}
				if (grantType === "authorization_code") {
					const code = params.get("code")
					const authorization = code ? authorizationCodes.get(code) : undefined
					const verifier = params.get("code_verifier")
					const challenge = verifier ? createHash("sha256").update(verifier).digest("base64url") : undefined
					if (
						!authorization ||
						challenge !== authorization.codeChallenge ||
						params.get("redirect_uri") !== authorization.redirectUri
					) {
						sendJson(response, 400, { error: "invalid_grant" })
						return
					}
					const expiresIn = scenario === "oauth-expiring" ? 1 : 3600
					authorizationCodes.delete(code)
					record("oauth_token_issued", { grantType, pkceVerified: true, expiresIn })
					oauthAccessTokenExpiresAt = Date.now() + expiresIn * 1000
					sendJson(response, 200, {
						access_token: oauthAccessToken,
						token_type: "Bearer",
						expires_in: expiresIn,
						refresh_token: oauthRefreshToken,
						scope: "mcp:tools",
					})
					return
				}
				if (grantType === "refresh_token" && params.get("refresh_token") === oauthRefreshToken) {
					record("oauth_token_issued", { grantType, expiresIn: 3600 })
					oauthAccessTokenExpiresAt = Date.now() + 3_600_000
					sendJson(response, 200, {
						access_token: oauthAccessToken,
						token_type: "Bearer",
						expires_in: 3600,
						refresh_token: oauthRefreshToken,
						scope: "mcp:tools",
					})
					return
				}
				sendJson(response, 400, { error: "unsupported_grant_type" })
				return
			}

			if (url.pathname !== "/mcp") {
				sendJson(response, 404, { error: "not found" })
				return
			}

			const authorization = request.headers.authorization
			const authorized = oauthEnabled
				? authorization === `Bearer ${oauthAccessToken}` && Date.now() < oauthAccessTokenExpiresAt
				: expectedBearerToken === undefined || authorization === `Bearer ${expectedBearerToken}`
			const sessionIdHeader = request.headers["mcp-session-id"]
			const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined
			record("http_request", {
				method: request.method,
				path: url.pathname,
				sessionId,
				authorized,
				testHeader: request.headers["x-kimchi-e2e"],
			})

			if (!authorized) {
				record("http_unauthorized", { method: request.method, path: url.pathname })
				response.writeHead(401, {
					"www-authenticate": oauthEnabled
						? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
						: "Bearer",
				})
				response.end("Unauthorized")
				return
			}

			if (request.method === "POST") {
				const body = await readJsonBody(request)
				const activeSession = sessionId ? sessions.get(sessionId) : undefined
				if (activeSession) {
					await activeSession.transport.handleRequest(request, response, body)
					return
				}
				if (!sessionId && isInitializeRequest(body)) {
					const server = createFixtureServer()
					const transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => randomUUID(),
						onsessioninitialized: (initializedSessionId) => {
							sessions.set(initializedSessionId, { server, transport })
							record("http_session_initialized", { sessionId: initializedSessionId })
						},
					})
					transport.onclose = () => {
						if (transport.sessionId) sessions.delete(transport.sessionId)
						record("http_session_closed", { sessionId: transport.sessionId })
					}
					await server.connect(transport)
					await transport.handleRequest(request, response, body)
					return
				}
				sendJson(response, 400, {
					jsonrpc: "2.0",
					error: { code: -32_000, message: "Bad Request: no valid session ID provided" },
					id: null,
				})
				return
			}

			const activeSession = sessionId ? sessions.get(sessionId) : undefined
			if (activeSession && (request.method === "GET" || request.method === "DELETE")) {
				await activeSession.transport.handleRequest(request, response)
				return
			}
			sendJson(response, 400, { error: "invalid or missing MCP session" })
		} catch (error) {
			record("http_error", { message: error instanceof Error ? error.message : String(error) })
			if (!response.headersSent) sendJson(response, 500, { error: "fixture server error" })
			else response.end()
		}
	})

	await new Promise((resolve, reject) => {
		httpServer.once("error", reject)
		httpServer.listen(0, "127.0.0.1", resolve)
	})
	const address = httpServer.address()
	if (!address || typeof address === "string") throw new Error("Fixture HTTP server did not get a TCP address")
	origin = `http://127.0.0.1:${address.port}`
	record("http_listening", { url: transportKind === "sse" ? `${origin}/sse` : `${origin}/mcp` })

	const shutdown = async (signal) => {
		record("process_stopping", { signal })
		for (const { transport } of sessions.values()) await transport.close().catch(() => {})
		await new Promise((resolve) => httpServer.close(resolve))
		process.exit(0)
	}
	process.once("SIGTERM", () => void shutdown("SIGTERM"))
	process.once("SIGINT", () => void shutdown("SIGINT"))
}

process.on("exit", (code) => record("process_exited", { code }))
record("process_started", { transport: transportKind })

if (fixtureBehavior.startup?.type === "exit") process.exit(fixtureBehavior.startup.code)
else if (transportKind === "http" || transportKind === "sse") await runHttpFixture()
else await createFixtureServer().connect(new StdioServerTransport())
