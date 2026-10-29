/**
 * Post-auth session healing regression: when an OAuth grant lands for a server
 * (auth-complete, /mcp-auth, a same-process probe, or an out-of-band write), a
 * running chat used to keep reporting the server as not connected — no tools —
 * until an explicit mcp({ connect }) or a restart.
 *
 * Session-lazy healing (PR #1574): a grant write alone does not reconnect the
 * live session. The heal happens synchronously inside the NEXT tool call that
 * touches the server, whose readiness gates retry a non-interactive reconnect
 * that re-reads the shared credential store. These tests pin that contract —
 * including the boundary itself (status stays not-connected until the call) —
 * so the patch cannot silently lose its hunks.
 *
 * Scaffold adapted from the acceptance suite of the closed sibling PR #1577
 * (commit c8628713, grant-write broadcast approach), with assertions rewritten
 * to the lazy semantics this branch ships.
 *
 * Driven against the real pi-mcp-adapter with a stub streamable-HTTP MCP server;
 * the credential store is the in-memory test store so no keychain is involved.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"

const SERVER_NAME = "demooauth"
const GOOD_TOKEN = "good-bearer-token"
const STUB_TOOL = "demo_echo"

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let body = ""
		req.setEncoding("utf8")
		req.on("data", (chunk: string) => {
			body += chunk
		})
		req.on("end", () => {
			try {
				resolve(body === "" ? {} : (JSON.parse(body) as Record<string, unknown>))
			} catch (error) {
				reject(error)
			}
		})
	})
}

/**
 * Minimal streamable-HTTP MCP server gated on a bearer token, plus an OAuth
 * authorization server on the same origin: resource metadata, AS metadata,
 * dynamic client registration, auto-approving /authorize, and a /token
 * exchange that issues the good bearer token.
 */
function startStubMcpServer(): Promise<{ server: Server; url: string }> {
	const server = createServer(async (req, res: ServerResponse) => {
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		const { pathname, searchParams } = new URL(req.url ?? "/", base)
		if (
			pathname === "/.well-known/oauth-protected-resource" ||
			pathname.startsWith("/.well-known/oauth-protected-resource/")
		) {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }))
			return
		}
		if (pathname === "/.well-known/oauth-authorization-server") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(
				JSON.stringify({
					issuer: base,
					authorization_endpoint: `${base}/authorize`,
					token_endpoint: `${base}/token`,
					registration_endpoint: `${base}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
				}),
			)
			return
		}
		if (pathname === "/register") {
			const body = await readJsonBody(req)
			res.writeHead(201, { "content-type": "application/json" })
			res.end(JSON.stringify({ ...body, client_id: "stub-client-id" }))
			return
		}
		if (pathname === "/authorize") {
			const redirectUri = searchParams.get("redirect_uri")
			const target = new URL(redirectUri ?? `${base}/unused`)
			target.searchParams.set("code", "stub-auth-code")
			const state = searchParams.get("state")
			if (state !== null) target.searchParams.set("state", state)
			res.writeHead(302, { location: target.toString() })
			res.end()
			return
		}
		if (pathname === "/token") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ access_token: GOOD_TOKEN, token_type: "Bearer", expires_in: 3600 }))
			return
		}
		const authed = req.headers.authorization === `Bearer ${GOOD_TOKEN}`
		const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
		const id = (body.id as string | number | null) ?? null
		const respond = (result: unknown) => {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
		}
		if (!authed) {
			// The adapter's unauthenticated shape probe (mcp-probe.ts) only treats a
			// Bearer challenge as MCP-gated when it carries a JSON-RPC envelope.
			res.writeHead(401, {
				"content-type": "application/json",
				"www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
			})
			res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }))
			return
		}
		if (body.method === "initialize") {
			respond({
				protocolVersion: (body.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: SERVER_NAME, version: "1.0.0" },
			})
			return
		}
		if (body.method === "notifications/initialized") {
			res.writeHead(202)
			res.end()
			return
		}
		if (body.method === "tools/list") {
			respond({
				tools: [
					{
						name: STUB_TOOL,
						description: "Echo the input text.",
						inputSchema: { type: "object", properties: { text: { type: "string" } } },
					},
				],
			})
			return
		}
		if (body.method === "tools/call") {
			const args = (body.params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {}
			respond({ content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }], isError: false })
			return
		}
		respond({})
	})
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo
			resolve({ server, url: `http://127.0.0.1:${port}/mcp` })
		})
	})
}

function createSessionContext(cwd: string) {
	// hasUI: false — the headless gateway path; the adapter never reaches for
	// ui primitives here, and the browser-open attempt degrades to a logged
	// warning plus manual callback waiting.
	return createContext({ cwd, hasUI: false, ui: undefined })
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n")
}

interface GatewayResult {
	content: Array<{ type: string; text?: string }>
	details?: Record<string, unknown>
}

describe("MCP post-auth session healing (lazy: heal at next tool call)", () => {
	let homeDir: string
	let agentDir: string
	let cwd: string
	let stub: { server: Server; url: string }

	beforeAll(async () => {
		homeDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-auth-heal-"))
		agentDir = mkdtempSync(join(homeDir, "agent-"))
		cwd = mkdtempSync(join(homeDir, "project-"))
		vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory")
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
		vi.stubEnv("PI_PACKAGE_DIR", process.cwd())
		stub = await startStubMcpServer()
	})

	afterAll(async () => {
		vi.unstubAllEnvs()
		// Keep-alive sockets from the clients keep close() pending; drop them.
		stub.server.closeAllConnections()
		await new Promise<void>((resolve) => stub.server.close(() => resolve()))
		rmSync(homeDir, { recursive: true, force: true })
	})

	async function createSessionGateway(
		serverName: string,
	): Promise<(params: Record<string, unknown>) => Promise<GatewayResult>> {
		const { createMcpAdapter } = await import("pi-mcp-adapter")
		const host = createExtensionApi()
		const api = {
			...host.api,
			getFlag: () => undefined,
			unregisterTool: (name: string) => {
				const tool = host.getRegisteredTools().find((candidate) => candidate.name === name)
				if (tool === undefined) return false
				host.registerTool.mock.calls.splice(
					host.registerTool.mock.calls.findIndex(([candidate]) => candidate.name === name),
					1,
				)
				return true
			},
		} as unknown as typeof host.api
		createMcpAdapter({
			config: {
				mcpServers: {
					[serverName]: { url: stub.url, lifecycle: "lazy" as const },
				},
				settings: { autoAuth: false, directTools: false, toolPrefix: "none" as const },
			},
		})(api)
		const ctx = createSessionContext(cwd)
		await host.emit("session_start", { type: "session_start", reason: "startup" }, ctx)
		const gateway = await vi.waitFor(
			() => {
				if (!host.getActiveToolNames().includes("mcp")) throw new Error("gateway tool not registered yet")
				return host.getRegisteredTool("mcp")
			},
			{ timeout: 10_000, interval: 50 },
		)
		return async (params: Record<string, unknown>): Promise<GatewayResult> =>
			(await gateway.execute(
				`test-${Math.random().toString(36).slice(2)}`,
				params,
				undefined,
				undefined,
				ctx as ExtensionToolContext,
			)) as GatewayResult
	}

	it("a grant write alone does not reconnect; the next tool call heals the session, without mcp({ connect })", async () => {
		const { updateMcpOAuthTokensForUrl, inspectMcpOAuthTokensForUrl } = await import("pi-mcp-adapter/oauth")
		const execute = await createSessionGateway(SERVER_NAME)
		const status = async (): Promise<GatewayResult> => execute({})

		// Baseline: configured, visible, not connected, tools unknown, no token.
		const baseline = await vi.waitFor(
			async () => {
				const result = await status()
				if (!textOf(result).includes(SERVER_NAME)) throw new Error("server not visible to session yet")
				return result
			},
			{ timeout: 10_000, interval: 100 },
		)
		expect(baseline.details?.error).toBeUndefined()
		expect(baseline.details?.connectedCount).toBe(0)
		expect(textOf(baseline)).not.toContain(STUB_TOOL)
		expect(inspectMcpOAuthTokensForUrl(SERVER_NAME, stub.url).status).toBe("absent")

		// The grant write: the same store write the auth-complete flow performs
		// (completeAuthFromInput → updateTokens). No connect call follows.
		await updateMcpOAuthTokensForUrl(SERVER_NAME, stub.url, { accessToken: GOOD_TOKEN })

		// The lazy-heal boundary itself: a grant write on its own does not
		// reconnect the live session. A user whose previous turn already concluded
		// "no tools" sees the corrected behavior on their NEXT prompt — the heal
		// is synchronous with it, inside the first call that touches the server.
		const afterWrite = await status()
		expect(afterWrite.details?.connectedCount).toBe(0)

		// The next tool call performs the non-interactive reconnect (re-reading
		// the shared credential store it just wrote to) and succeeds.
		const call = await execute({ tool: STUB_TOOL, server: SERVER_NAME, args: { text: "hi" } })
		expect(call.details?.error).toBeUndefined()
		expect(textOf(call)).toContain("echo:hi")

		// The heal leaves the session connected and re-listed.
		const healed = await status()
		expect(healed.details?.connectedCount).toBe(1)
		const tools = await execute({ server: SERVER_NAME })
		expect(tools.details?.error).toBeUndefined()
		expect(textOf(tools)).toContain(STUB_TOOL)
	}, 60_000)

	it("auth-complete reports success; the same-session heal lands at the next call", async () => {
		// Distinct name from the first test: the in-memory credential store is
		// process-scoped and test one already wrote a grant for SERVER_NAME.
		const serverName = `${SERVER_NAME}-complete`
		const execute = await createSessionGateway(serverName)

		// Baseline: configured but not connected.
		const baseline = await vi.waitFor(
			async () => {
				const result = await execute({})
				if (!textOf(result).includes(serverName)) throw new Error("server not visible to session yet")
				return result
			},
			{ timeout: 10_000, interval: 100 },
		)
		expect(baseline.details?.connectedCount).toBe(0)

		// Start OAuth through the harness-native path.
		const started = await execute({ action: "auth-start", server: serverName })
		expect(started.details?.error).toBeUndefined()
		const authorizationUrl = started.details?.authorizationUrl as string
		expect(authorizationUrl).toContain(`${new URL(stub.url).origin}/authorize`)

		// Consent (the stub auto-302s); capture the loopback redirect URL.
		const consent = await fetch(authorizationUrl, { redirect: "manual" })
		const redirectUrl = consent.headers.get("location")
		expect(redirectUrl).toContain("code=")

		// Complete the grant; auth-complete returns success.
		const completed = await execute({
			action: "auth-complete",
			server: serverName,
			args: { redirectUrl },
		})
		expect(completed.details?.error).toBeUndefined()
		expect(completed.details?.authenticated).toBe(true)

		// The heal for this session lands at the next call...
		const call = await execute({ tool: STUB_TOOL, server: serverName, args: { text: "hi" } })
		expect(call.details?.error).toBeUndefined()
		expect(textOf(call)).toContain("echo:hi")

		// ...and leaves the session connected.
		const status = await execute({})
		expect(status.details?.connectedCount).toBe(1)
	}, 60_000)
})
